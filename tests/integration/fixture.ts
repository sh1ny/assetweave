import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { verifyWindowsProfile } from '@assetweave/server/profile';

export const windowsOnly = process.platform !== 'win32';
const rootUrl = new URL('../../../', import.meta.url);
const serverEntry = new URL('apps/server/dist/src/main.js', rootUrl).href;
const mcpEntry = fileURLToPath(new URL('apps/mcp/dist/src/main.js', rootUrl));
export const mediaFile = (name: string): string => fileURLToPath(new URL(`tests/fixtures/media/${name}`, rootUrl));

// Use a separate OS process, not startServer() in the Node test runner. Port 0
// avoids collisions when the root suite and other integrations run together.
// This evaluated child has no static project import: it loads this checkout's
// compiled server URL passed at launch, rather than a globally installed copy.
const serviceScript = `
const { startServer } = await import(process.env.ASSETWEAVE_SERVER_ENTRY);
try {
  const running = await startServer({ profilePath: process.env.ASSETWEAVE_DATA_DIR,
    webDist: process.env.ASSETWEAVE_WEB_DIST, port: 0 });
  process.stdout.write('ASSETWEAVE_READY ' + running.origin + '\\n');
  process.on('message', message => {
    if (message !== 'stop') return;
    void running.close().then(() => process.disconnect(), error => {
      console.error(error); process.exitCode = 1; process.disconnect();
    });
  });
} catch (error) {
  console.error(error); process.exitCode = 1;
}
`;

export interface ServiceProcess { origin: string; child: ChildProcess }

export function fixture(t: TestContext) {
  assert.ok(process.env.LOCALAPPDATA, 'Windows integration tests require LOCALAPPDATA.');
  const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'AssetWeave-Workflow-Test-'));
  const profile = join(root, 'private');
  const webDist = join(root, 'web');
  try {
    verifyWindowsProfile(profile, 'create');
    mkdirSync(join(webDist, 'assets'), { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><html><body>Private test shell</body></html>');
    writeFileSync(join(webDist, 'assets', 'shell.js'), 'export const local = true;');
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const children = new Set<ChildProcess>();
  const clients = new Set<Client>();

  async function stop(service: ServiceProcess): Promise<void> {
    const { child } = service;
    if (child.exitCode !== null || child.signalCode !== null) {
      children.delete(child);
      return;
    }
    const forced = await new Promise<boolean>((resolve, reject) => {
      let killed = false;
      const timer = setTimeout(() => { killed = true; child.kill(); }, 20_000);
      const deadline = setTimeout(() => reject(new Error('Service could not be stopped.')), 25_000);
      child.once('exit', () => {
        clearTimeout(timer);
        clearTimeout(deadline);
        resolve(killed);
      });
      child.once('error', error => {
        clearTimeout(timer);
        clearTimeout(deadline);
        reject(error);
      });
      if (child.connected) child.send('stop');
      else child.kill();
    });
    children.delete(child);
    if (forced) throw new Error('Service did not stop after its close request.');
  }

  t.after(async () => {
    let failure: unknown;
    for (const client of clients) {
      try { await client.close(); }
      catch (error) { failure ??= error; }
    }
    for (const child of children) {
      try { await stop({ child, origin: '' }); }
      catch (error) { failure ??= error; }
    }
    rmSync(root, { recursive: true, force: true });
    if (failure) throw failure;
  });

  return {
    root, profile,
    async start(): Promise<ServiceProcess> {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', serviceScript], {
        env: { ...process.env, ASSETWEAVE_DATA_DIR: profile, ASSETWEAVE_WEB_DIST: webDist,
          ASSETWEAVE_SERVER_ENTRY: serverEntry },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      });
      children.add(child);
      let diagnostics = '';
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        diagnostics = (diagnostics + chunk).slice(-4096);
      });
      const origin = await new Promise<string>((resolve, reject) => {
        let lines = '';
        const timer = setTimeout(() => fail(new Error(`Service startup timed out: ${diagnostics}`)), 45_000);
        const cleanup = () => {
          clearTimeout(timer);
          child.off('error', fail);
          child.off('exit', exited);
          child.stdout?.off('data', data);
        };
        const fail = (error: Error) => { cleanup(); reject(error); };
        const exited = (code: number | null) => fail(new Error(`Service exited ${code} before ready: ${diagnostics}`));
        const data = (chunk: string) => {
          lines += chunk;
          let end: number;
          while ((end = lines.indexOf('\n')) >= 0) {
            const line = lines.slice(0, end).trim();
            lines = lines.slice(end + 1);
            if (line.startsWith('ASSETWEAVE_READY ')) {
              cleanup(); resolve(line.slice('ASSETWEAVE_READY '.length)); return;
            }
          }
        };
        child.once('error', fail);
        child.once('exit', exited);
        child.stdout?.setEncoding('utf8').on('data', data);
      });
      return { child, origin };
    },
    stop,
    async client(): Promise<Client> {
      const client = new Client({ name: 'assetweave-workflow-test', version: '0.1.0' });
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntry],
          env: { ...getDefaultEnvironment(), ASSETWEAVE_DATA_DIR: profile }, stderr: 'pipe', maxBufferSize: 60 * 1024 * 1024 }));
        clients.add(client);
        return client;
      } catch (error) {
        await client.close();
        throw error;
      }
    },
    async closeClient(client: Client): Promise<void> {
      await client.close();
      clients.delete(client);
    },
    bridgeHeaders(): Record<string, string> {
      const { bearer } = JSON.parse(readFileSync(join(profile, 'bridge.json'), 'utf8')) as { bearer: string };
      return { Authorization: `Bearer ${bearer}` };
    },
    async browserHeaders(service: ServiceProcess): Promise<Record<string, string>> {
      const { launcherToken } = JSON.parse(readFileSync(join(profile, 'launcher.json'), 'utf8')) as { launcherToken: string };
      const issued = await fetch(`${service.origin}/__local/pair-capability`, {
        method: 'POST', headers: { Authorization: `Bearer ${launcherToken}` },
      });
      assert.equal(issued.status, 201, await issued.clone().text());
      const { capability } = await issued.json() as { capability: string };
      const paired = await fetch(`${service.origin}/api/pair`, { method: 'POST',
        headers: { Origin: service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ capability }),
      });
      assert.equal(paired.status, 201, await paired.clone().text());
      const cookie = paired.headers.get('set-cookie')?.split(';', 1)[0];
      assert.ok(cookie);
      const session = await fetch(`${service.origin}/api/session`, { headers: { Cookie: cookie } });
      assert.equal(session.status, 200, await session.clone().text());
      const { csrfToken } = await session.json() as { csrfToken: string };
      return { Cookie: cookie, Origin: service.origin, 'x-assetweave-csrf': csrfToken };
    },
  };
}

export async function tool<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const first = result.content[0];
  assert.equal(first?.type, 'text');
  if (first?.type !== 'text') throw new Error(`No JSON response from ${name}`);
  const value: unknown = JSON.parse(first.text);
  assert.deepEqual(result.structuredContent, { data: value });
  return value as T;
}

export async function http<T>(service: ServiceProcess, headers: Record<string, string>, path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${service.origin}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, method === 'POST' ? 201 : 200, await response.clone().text());
  return response.json() as Promise<T>;
}
