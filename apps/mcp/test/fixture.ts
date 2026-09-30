import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod';
import { apiErrorSchema } from '@assetweave/contracts/errors';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { startServer, type RunningService } from '@assetweave/server/main';
import { verifyWindowsProfile } from '@assetweave/server/profile';

export const onlyWindows = process.platform !== 'win32';
export const entry = fileURLToPath(new URL('../src/main.js', import.meta.url));
export const image = fileURLToPath(new URL('../../../../tests/fixtures/media/bounded-sequence-0.png', import.meta.url));
export const opaque = fileURLToPath(new URL('../../../../tests/fixtures/media/opaque-script.html', import.meta.url));

export function fixture(t: TestContext) {
  assert.ok(process.env.LOCALAPPDATA, 'Windows integration tests require LOCALAPPDATA.');
  const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'AssetWeave-MCP-Test-'));
  const profile = join(root, 'private');
  verifyWindowsProfile(profile, 'create');
  const webDist = join(root, 'web');
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><html><body>Private test shell</body></html>');
  writeFileSync(join(webDist, 'assets', 'shell.js'), 'export const local = true;');
  const running: RunningService[] = [];
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const service of running) await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, profile, webDist,
    async start() {
      const service = await startServer({ profilePath: profile, webDist, port: 0 });
      running.push(service);
      return service;
    },
    async client() {
      const client = new Client({ name: 'assetweave-integration', version: '0.1.0' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry],
        env: { ...getDefaultEnvironment(), ASSETWEAVE_DATA_DIR: profile }, stderr: 'pipe', maxBufferSize: 60 * 1024 * 1024 }));
      clients.push(client);
      return client;
    },
    headers() {
      const bridge = z.object({ bearer: z.string() }).parse(JSON.parse(readFileSync(join(profile, 'bridge.json'), 'utf8')) as unknown);
      return { Authorization: `Bearer ${bridge.bearer}` };
    },
  };
}

export function toolJson(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const first = result.content[0];
  assert.equal(first?.type, 'text');
  if (first?.type !== 'text') throw new Error('Expected JSON tool text.');
  const value: unknown = JSON.parse(first.text);
  assert.deepEqual(z.strictObject({ data: z.json() }).parse(result.structuredContent).data, value);
  return value;
}

export function toolError(result: Awaited<ReturnType<Client['callTool']>>, code: string) {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  const first = result.content[0];
  assert.equal(first?.type, 'text');
  if (first?.type !== 'text') throw new Error('Expected JSON tool error.');
  const detail = apiErrorSchema.parse(JSON.parse(first.text) as unknown);
  assert.equal(detail.code, code);
  assert.ok(detail.message);
  assert.deepEqual(z.strictObject({ error: apiErrorSchema }).parse(result.structuredContent).error, detail);
  return detail;
}
