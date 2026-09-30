import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { entry, fixture, onlyWindows, toolError, toolJson } from './fixture.js';

const env = (profile: string) => ({ ...getDefaultEnvironment(), ASSETWEAVE_DATA_DIR: profile });

test('stdio initialization, tool list, missing service and diagnostics remain protocol-pure', { skip: onlyWindows, timeout: 10_000 }, async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, [entry], { env: env(f.profile), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (!child.killed) child.kill(); });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const initialized = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', () => { if (stdout.includes('\n')) resolve(); });
    child.on('error', reject);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`stdio exited ${code}`)));
    child.on('error', reject);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-stdio-test', version: '1.0.0' },
  } }) + '\n');
  await initialized;
  child.stdin.end();
  await exited;
  const messages: unknown[] = [];
  for (const line of stdout.trim().split(/\r?\n/u)) {
    assert.ok(line.startsWith('{'), `Non-protocol stdout: ${line}`);
    messages.push(JSON.parse(line) as unknown);
  }
  assert.ok(messages.some(message => message && typeof message === 'object' && 'id' in message && message.id === 1 && 'result' in message));
  assert.match(stderr, /ready on stdio/);
  assert.doesNotMatch(stderr, /Bearer |launcherToken|bridge\.json|private\/|private\\/);

  const client = await f.client();
  const list = await client.listTools();
  assert.ok(list.tools.some(tool => tool.name === 'capture_files'));
  assert.ok(list.tools.some(tool => tool.name === 'queries_context'));
  assert.ok(list.tools.some(tool => tool.name === 'media_original'));
  const failure = await client.callTool({ name: 'catalog_projects', arguments: {} });
  assert.match(toolError(failure, 'SERVICE_UNAVAILABLE').message!, /Start .*pnpm start/);
  assert.equal(existsSync(join(f.profile, 'owner.lock')), false);
  assert.equal(existsSync(join(f.profile, 'bridge.json')), false);
});

test('restart rotates the bridge credential and requires a new MCP bridge process', { skip: onlyWindows }, async t => {
  const f = fixture(t);
  const first = await f.start();
  const client = await f.client();
  const firstRecords = toolJson(await client.callTool({ name: 'catalog_projects', arguments: {} }));
  assert.ok(firstRecords && typeof firstRecords === 'object' && 'items' in firstRecords);
  const oldDiscovery = readFileSync(join(f.profile, 'bridge.json'), 'utf8');
  await first.close();
  const second = await f.start();
  const nextDiscovery = readFileSync(join(f.profile, 'bridge.json'), 'utf8');
  assert.notEqual(nextDiscovery, oldDiscovery);
  const refused = await client.callTool({ name: 'catalog_projects', arguments: {} });
  assert.match(toolError(refused, 'SERVICE_UNAVAILABLE').message!, /Restart this MCP bridge/);
  const fresh = await f.client();
  toolJson(await fresh.callTool({ name: 'catalog_projects', arguments: {} }));
  await second.close();
});

test('another profile discovery cannot redirect a bridge to a different owner or reveal credentials', { skip: onlyWindows }, async t => {
  const own = fixture(t);
  const other = fixture(t);
  await own.start();
  const foreign = await other.start();
  const foreignBridge = readFileSync(join(foreign.profile.path, 'bridge.json'), 'utf8');
  const ownBridge = readFileSync(join(own.profile, 'bridge.json'), 'utf8');
  const foreignBearer = JSON.parse(foreignBridge) as { bearer: string };
  // A substituted record with the selected profile but another owner's origin/bearer must also fail.
  const forged = JSON.parse(ownBridge) as { origin: string; bearer: string; profile: string; pid: number; instanceId: string };
  const before = await own.client();
  toolJson(await before.callTool({ name: 'catalog_projects', arguments: {} }));
  forged.origin = foreign.origin;
  forged.bearer = foreignBearer.bearer;
  forged.instanceId = randomUUID();
  writeFileSync(join(own.profile, 'bridge.json'), JSON.stringify(forged));
  const result = await before.callTool({ name: 'catalog_projects', arguments: {} });
  const detail = toolError(result, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(detail), new RegExp(foreignBearer.bearer));
  assert.equal(detail.message.includes(own.profile), false);
  const newlyStarted = await own.client();
  toolError(await newlyStarted.callTool({ name: 'catalog_projects', arguments: {} }), 'SERVICE_UNAVAILABLE');
});
