import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import fastifyStatic from '@fastify/static';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { AppModule } from './app.module.js';
import { installLocalAccess } from './runtime/local-access.plugin.js';
import { LocalAccessService } from './runtime/local-access.service.js';
import { ProfileService } from './runtime/profile.service.js';

export interface StartOptions { profilePath?: string; webDist?: string; port?: number }
export interface RunningService {
  origin: string;
  profile: ProfileService;
  close(): Promise<void>;
}

const defaultWebDist = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

export async function startServer(options: StartOptions = {}): Promise<RunningService> {
  const webDist = options.webDist ?? defaultWebDist;
  if (!existsSync(join(webDist, 'index.html')) || !existsSync(join(webDist, 'assets'))) {
    throw new Error('Built browser files are missing. Run `corepack pnpm build` before starting the local service.');
  }
  const configuredPort = process.env.ASSETWEAVE_PORT ?? '4317';
  if (options.port === undefined && !/^[1-9]\d{0,4}$/.test(configuredPort)) {
    throw new Error('ASSETWEAVE_PORT must be a decimal integer between 1 and 65535.');
  }
  const port = options.port ?? Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('ASSETWEAVE_PORT must be an integer between 1 and 65535 (0 is reserved for tests).');
  }
  const profile = ProfileService.open(options.profilePath);
  let app: NestFastifyApplication | undefined;
  try {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(profile, webDist),
      new FastifyAdapter({ trustProxy: false, logger: false, bodyLimit: 1024 * 1024 }),
      { logger: ['error', 'warn'] },
    );
    const fastify: FastifyInstance = app.getHttpAdapter().getInstance();
    const access = app.get(LocalAccessService);
    installLocalAccess(fastify, access);
    fastify.register(fastifyStatic, {
      root: join(webDist, 'assets'),
      prefix: '/assets/',
      index: false,
      dotfiles: 'deny',
      wildcard: true,
    });
    await app.init();
    await app.listen(port, '127.0.0.1');
    const location = new URL(await app.getUrl());
    if (location.hostname !== '127.0.0.1') throw new Error('Service did not bind to the required IPv4 loopback address.');
    const origin = location.origin;
    access.setOrigin(origin);
    profile.publishDiscovery(origin, access.bridgeBearer, access.launcherToken);
    let closed = false;
    const runningApp = app;
    return {
      origin,
      profile,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          await runningApp.close();
        } finally {
          profile.close();
        }
      },
    };
  } catch (failure) {
    try {
      await app?.close();
    } finally {
      profile.close();
    }
    throw failure;
  }
}

async function pairFromLauncher(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Pairing codes are shown only in an interactive terminal. Run `corepack pnpm pair` in your own terminal.');
  }
  const profile = ProfileService.forLauncher();
  const launcher = profile.readLauncher();
  if (!launcher.launcherToken || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(launcher.origin)) {
    throw new Error('Launcher discovery is invalid. Start the local service for the selected profile.');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question('Press Enter to request and display a one-time browser pairing code (Ctrl+C cancels). ');
  } finally {
    terminal.close();
  }
  profile.verify();
  let response: Response;
  try {
    response = await fetch(`${launcher.origin}/__local/pair-capability`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${launcher.launcherToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('The selected local service is unreachable. Start it with `corepack pnpm start` for the same profile, then retry.');
  }
  if (!response.ok) throw new Error('The local service refused this launcher credential. Restart `corepack pnpm pair` against its current profile.');
  const body = await response.json() as { capability: string; expiresAt: number };
  if (typeof body.capability !== 'string') throw new Error('The local service returned an invalid pairing response.');
  console.log(`One-time browser pairing code (valid for 2 minutes): ${body.capability}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'pair') return pairFromLauncher();
  if (command !== 'start') throw new Error('Choose `corepack pnpm start` to run the service or `corepack pnpm pair` in an interactive terminal.');
  const running = await startServer();
  console.log(`AssetWeave is listening at ${running.origin} (profile: ${running.profile.path}). Use \`corepack pnpm pair\` in an interactive terminal to pair a browser.`);
  const stop = () => {
    void running.close().then(() => { process.exitCode = 0; }, (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
