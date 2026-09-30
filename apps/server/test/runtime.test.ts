import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningService } from '../src/main.js';
import { ProfileService, resolveProfilePath, verifyWindowsProfile } from '../src/runtime/profile.service.js';

const windowsOnly = process.platform !== 'win32';

function profileFixture(t: TestContext) {
  assert.ok(process.env.LOCALAPPDATA, 'Windows tests require LOCALAPPDATA.');
  const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'AssetWeave-Runtime-Test-'));
  const running: RunningService[] = [];
  t.after(async () => {
    try {
      for (const service of running) await service.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const profilePath = join(root, 'private');
  verifyWindowsProfile(profilePath, 'create');
  const webDist = join(root, 'web');
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><html><body>Local browser connection</body></html>');
  writeFileSync(join(webDist, 'assets', 'shell.js'), 'export const local = true;');
  return {
    root, profilePath, webDist,
    async start(): Promise<RunningService> {
      const service = await startServer({ profilePath, webDist, port: 0 });
      running.push(service);
      return service;
    },
  };
}

async function pairBrowser(service: RunningService) {
  const launcher = JSON.parse(readFileSync(join(service.profile.path, 'launcher.json'), 'utf8')) as { launcherToken: string };
  const response = await fetch(`${service.origin}/__local/pair-capability`, {
    method: 'POST', headers: { Authorization: `Bearer ${launcher.launcherToken}` },
  });
  assert.equal(response.status, 201);
  const { capability, expiresAt } = await response.json() as { capability: string; expiresAt: number };
  const paired = await fetch(`${service.origin}/api/pair`, {
    method: 'POST', headers: { Origin: service.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ capability }),
  });
  assert.equal(paired.status, 201);
  const setCookie = paired.headers.get('set-cookie');
  assert.match(setCookie ?? '', /HttpOnly; SameSite=Strict/);
  const cookie = setCookie!.split(';', 1)[0]!;
  const sessionResponse = await fetch(`${service.origin}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as { csrfToken: string };
  return { cookie, csrfToken: session.csrfToken, capability, expiresAt, launcherToken: launcher.launcherToken };
}

function rawHostRequest(origin: string, host: string, path = '/'): Promise<number> {
  const { hostname, port } = new URL(origin);
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const request = httpRequest({ hostname, port, path, method: 'GET', headers: { Host: host } }, (response) => {
    response.resume();
    response.on('end', () => resolve(response.statusCode ?? 0));
  });
  request.on('error', reject);
  request.end();
  return promise;
}

test('a private profile has one live owner, an independently running listener, and genuine shell and API boundaries', { skip: windowsOnly }, async (t) => {
  const fixture = profileFixture(t);
  const { profilePath, webDist } = fixture;
  const service = await fixture.start();
  const lock = readFileSync(join(profilePath, 'owner.lock'), 'utf8');
  await assert.rejects(startServer({ profilePath, webDist, port: 0 }), /already owned by live process/);
  assert.equal(readFileSync(join(profilePath, 'owner.lock'), 'utf8'), lock);
  const shell = await fetch(service.origin);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal((await fetch(`${service.origin}/assets/shell.js`)).status, 200);
  assert.equal(await rawHostRequest(service.origin, `localhost:${new URL(service.origin).port}`), 403);
  assert.equal(await rawHostRequest(service.origin, new URL(service.origin).host, '/assets/../api/connection'), 400);
  assert.equal((await fetch(`${service.origin}/api/connection`)).status, 401);
  assert.equal((await fetch(`${service.origin}/media/unknown`)).status, 401);

  const discovery = JSON.parse(readFileSync(join(profilePath, 'bridge.json'), 'utf8')) as { profile: string; origin: string; bearer: string };
  assert.equal(discovery.profile.toLowerCase(), service.profile.path.toLowerCase());
  assert.equal(discovery.origin, service.origin);
  const headers = { Authorization: `Bearer ${discovery.bearer}` };
  const nonAsciiSameLength = 'é'.repeat(discovery.bearer.length);
  assert.equal((await fetch(`${service.origin}/api/connection`, {
    headers: { Authorization: `Bearer ${nonAsciiSameLength}` },
  })).status, 401);
  assert.equal((await fetch(`${service.origin}/__local/pair-capability`, { method: 'POST', headers })).status, 401);
  const connection = await fetch(`${service.origin}/api/connection`, { headers });
  assert.equal(connection.status, 200);
  assert.equal((await connection.json() as { profile: string }).profile, discovery.profile);
  const missingApi = await fetch(`${service.origin}/api/unknown`, { headers });
  assert.equal(missingApi.status, 404);
  assert.doesNotMatch(await missingApi.text(), /Local browser connection/);
  const missingMedia = await fetch(`${service.origin}/media/unknown`, { headers });
  assert.equal(missingMedia.status, 404);
  assert.doesNotMatch(await missingMedia.text(), /Local browser connection/);
});

test('bridge discovery keeps the event loop responsive and rechecks the private profile on each read', { skip: windowsOnly }, async (t) => {
  const fixture = profileFixture(t);
  const service = await fixture.start();
  const opened: string[] = [];
  const opening = ProfileService.forBridgeDiscovery(fixture.profilePath).then(profile => {
    opened.push('discovered');
    return profile;
  });
  await new Promise<void>(resolve => setImmediate(() => { opened.push('timer'); resolve(); }));
  assert.equal(opened[0], 'timer', 'initial ACL verification must not block the event loop');
  const profile = await opening;

  const readOrder: string[] = [];
  const reading = profile.readBridge().then(discovery => {
    readOrder.push('read');
    return discovery;
  });
  await new Promise<void>(resolve => setImmediate(() => { readOrder.push('timer'); resolve(); }));
  assert.equal(readOrder[0], 'timer', 'each read must verify asynchronously');
  const discovery = await reading;
  assert.equal(discovery.origin, service.origin);
  assert.equal(discovery.instanceId, service.profile.instanceId);
  assert.equal(discovery.bearer.length, 43);

  const replaced = join(fixture.profilePath, 'unexpected-junction');
  symlinkSync(fixture.webDist, replaced, 'junction');
  try {
    await assert.rejects(profile.readBridge(), /reparse point inside private profile/);
  } finally {
    rmdirSync(replaced);
  }
  assert.deepEqual(await profile.readBridge(), discovery);

  const substituted = join(fixture.root, 'profile-junction');
  symlinkSync(fixture.profilePath, substituted, 'junction');
  await assert.rejects(ProfileService.forBridgeDiscovery(substituted), /reparse-point profile path/);
});

test('a single-use profile-bound code pairs a browser; origin, cookie, CSRF, and bearer transitions fail closed', { skip: windowsOnly }, async (t) => {
  const first = profileFixture(t);
  const service = await first.start();
  const launcher = JSON.parse(readFileSync(join(first.profilePath, 'launcher.json'), 'utf8')) as { launcherToken: string };
  const issue = async () => {
    const response = await fetch(`${service.origin}/__local/pair-capability`, {
      method: 'POST', headers: { Authorization: `Bearer ${launcher.launcherToken}` },
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ capability: string; expiresAt: number }>;
  };
  const pending = await issue();
  const pair = (origin: string | undefined, capability: string) => fetch(`${service.origin}/api/pair`, {
    method: 'POST', headers: { ...(origin === undefined ? {} : { Origin: origin }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ capability }),
  });
  assert.equal((await pair(undefined, pending.capability)).status, 403);
  assert.equal((await pair('null', pending.capability)).status, 403);
  assert.equal((await pair('https://foreign.example', pending.capability)).status, 403);
  assert.equal((await pair(service.origin, 'not-a-capability')).status, 401);
  assert.equal((await fetch(`${service.origin}/__local/pair-capability`, { method: 'POST' })).status, 401);

  const accepted = await pair(service.origin, pending.capability);
  assert.equal(accepted.status, 201);
  assert.equal((await pair(service.origin, pending.capability)).status, 401);
  const setCookie = accepted.headers.get('set-cookie')!;
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(';', 1)[0]!;
  const current = await fetch(`${service.origin}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(current.status, 200);
  const { csrfToken } = await current.json() as { csrfToken: string };
  const connection = await fetch(`${service.origin}/api/connection`, { headers: { Cookie: cookie } });
  assert.equal(connection.status, 200);
  assert.equal((await connection.json() as { profile: string }).profile, service.profile.path);
  const deletion = (headers: Record<string, string>) => fetch(`${service.origin}/api/session`, { method: 'DELETE', headers });
  assert.equal((await deletion({ Cookie: cookie, Origin: service.origin })).status, 403);
  assert.equal((await deletion({ Cookie: cookie, Origin: 'https://foreign.example', 'x-assetweave-csrf': csrfToken })).status, 403);
  assert.equal((await deletion({ Cookie: cookie, Origin: service.origin, 'x-assetweave-csrf': csrfToken })).status, 200);
  assert.equal((await fetch(`${service.origin}/api/session`, { headers: { Cookie: cookie } })).status, 401);

  const expired = await issue();
  const originalNow = Date.now;
  try {
    Date.now = () => expired.expiresAt + 1;
    assert.equal((await pair(service.origin, expired.capability)).status, 401);
  } finally {
    Date.now = originalNow;
  }

  const other = profileFixture(t);
  const otherService = await other.start();
  const oneProfileOnly = await issue();
  assert.equal((await fetch(`${otherService.origin}/api/pair`, {
    method: 'POST', headers: { Origin: otherService.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ capability: oneProfileOnly.capability }),
  })).status, 401);
  assert.equal((await fetch(`${otherService.origin}/__local/pair-capability`, {
    method: 'POST', headers: { Authorization: `Bearer ${launcher.launcherToken}` },
  })).status, 401);
  const bearer = JSON.parse(readFileSync(join(first.profilePath, 'bridge.json'), 'utf8')) as { bearer: string };
  assert.equal((await fetch(`${otherService.origin}/api/connection`, { headers: { Authorization: `Bearer ${bearer.bearer}` } })).status, 401);
  assert.equal((await fetch(`${service.origin}/api/connection`, { headers: { Authorization: `Bearer ${bearer.bearer}`, Origin: 'https://foreign.example' } })).status, 403);
});

test('restart rotates both authorization channels; hostile multipart is rejected before staging', { skip: windowsOnly }, async (t) => {
  const fixture = profileFixture(t);
  const { profilePath } = fixture;
  const service = await fixture.start();
  const paired = await pairBrowser(service);
  const bearer = JSON.parse(readFileSync(join(profilePath, 'bridge.json'), 'utf8')) as { bearer: string };
  const hostile = await fetch(`${service.origin}/api/capture`, {
    method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'multipart/form-data; boundary=test' },
    body: '--test\r\nContent-Disposition: form-data; name="file"; filename="hostile.png"\r\n\r\nbytes\r\n--test--',
  });
  assert.equal(hostile.status, 403);
  assert.deepEqual(readdirSync(join(profilePath, 'staging')), []);
  const noninteractive = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url)), 'pair'], {
    env: { ...process.env, ASSETWEAVE_DATA_DIR: profilePath }, encoding: 'utf8', timeout: 60_000,
  });
  assert.ifError(noninteractive.error);
  assert.equal(noninteractive.signal, null);
  assert.equal(noninteractive.status, 1, noninteractive.stderr);
  assert.equal(noninteractive.stdout, '');
  await service.close();
  const restarted = await fixture.start();
  assert.equal((await fetch(`${restarted.origin}/api/session`, { headers: { Cookie: paired.cookie } })).status, 401);
  assert.equal((await fetch(`${restarted.origin}/api/connection`, { headers: { Authorization: `Bearer ${bearer.bearer}` } })).status, 401);
  assert.equal((await fetch(`${restarted.origin}/api/pair`, {
    method: 'POST', headers: { Origin: restarted.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ capability: paired.capability }),
  })).status, 401);
});

test('only a confirmed dead owner can have its lock reclaimed', { skip: windowsOnly }, async (t) => {
  const fixture = profileFixture(t);
  const { profilePath, webDist } = fixture;
  writeFileSync(join(profilePath, 'owner.lock'), '{\"pid\":\"unknown\",\"instanceId\":\"broken\"}');
  await assert.rejects(startServer({ profilePath, webDist, port: 0 }), /Owner lock is malformed/);
  assert.equal(readFileSync(join(profilePath, 'owner.lock'), 'utf8'), '{\"pid\":\"unknown\",\"instanceId\":\"broken\"}');

  const stopped = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.equal(stopped.status, 0);
  assert.equal(typeof stopped.pid, 'number');
  writeFileSync(join(profilePath, 'owner.lock'), JSON.stringify({ pid: stopped.pid, instanceId: 'stale-owner' }));
  const service = await fixture.start();
  assert.equal((await fetch(service.origin)).status, 200);
  assert.notEqual(JSON.parse(readFileSync(join(profilePath, 'owner.lock'), 'utf8')).instanceId, 'stale-owner');
  assert.deepEqual(readdirSync(profilePath).filter((name) => name === '.owner-recovery'), []);
});

test('the profile stays outside the checkout and registered or configured sync locations', { skip: windowsOnly }, async (t) => {
  const { root, webDist } = profileFixture(t);
  const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
  await assert.rejects(startServer({ profilePath: join(checkout, '.assetweave'), webDist, port: 0 }), /outside the project source tree/);

  const configuredSyncRoot = join(root, 'configured-sync-root');
  mkdirSync(configuredSyncRoot);
  const previous = process.env.OneDriveConsumer;
  try {
    process.env.OneDriveConsumer = configuredSyncRoot;
    await assert.rejects(startServer({
      profilePath: join(configuredSyncRoot, 'private'), webDist, port: 0,
    }), /live or configured sync root/);
  } finally {
    if (previous === undefined) delete process.env.OneDriveConsumer;
    else process.env.OneDriveConsumer = previous;
  }
  assert.deepEqual(readdirSync(configuredSyncRoot), []);
});

test('ordinary ancestor ownership is unsafe even when its explicit DACL is restricted', { skip: windowsOnly }, async (t) => {
  const fixture = profileFixture(t);
  const service = await fixture.start();
  assert.equal((await fetch(service.origin)).status, 200, 'genuinely private profiles under Windows-owned ancestors still open');

  const foreignParent = join(fixture.root, 'foreign-owned-parent');
  mkdirSync(foreignParent);
  const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const ownerAttempt = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$path = ${psLiteral(foreignParent)}
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $path
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current) { throw 'Fixture owner is not the current user.' }
$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'))
$failure = ''
try { Set-Acl -LiteralPath $path -AclObject $acl } catch { $failure = $_.Exception.Message }
$owner = (Get-Acl -LiteralPath $path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -eq 'S-1-5-32-545') { exit 0 }
if ($owner -ne $current) { throw "Unexpected owner after assignment attempt: $owner" }
Write-Output "Owner reassignment unavailable: $failure"
exit 50
`], { encoding: 'utf8' });
  assert.ifError(ownerAttempt.error);
  assert.ok(ownerAttempt.status === 0 || ownerAttempt.status === 50, ownerAttempt.stderr);
  if (ownerAttempt.status === 0) {
    let unexpectedService: RunningService | undefined;
    try {
      await assert.rejects(async () => {
        unexpectedService = await startServer({ profilePath: join(foreignParent, 'private'), webDist: fixture.webDist, port: 0 });
      }, /ancestor is owned by another principal/);
      assert.deepEqual(readdirSync(foreignParent), [], 'startup must refuse before creating a profile or database');
    } finally {
      await unexpectedService?.close();
    }
  } else {
    t.diagnostic(ownerAttempt.stdout.trim());
  }

  // Unprivileged Windows tokens cannot normally set an arbitrary owner. Exercise the
  // actual ancestor-owner policy on a restricted security descriptor in that case too.
  const aclScript = fileURLToPath(new URL('../../scripts/profile-acl.ps1', import.meta.url));
  const descriptorProbe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
if (-not (Test-Path -LiteralPath ${psLiteral(aclScript)} -PathType Leaf)) { throw 'Production ACL script is missing from the test runtime path.' }
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(aclScript)}, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ('ACL policy script fails parsing: ' + (($errors | ForEach-Object { $_.Message }) -join '; ')) }
$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-TrustedAncestorOwner' }, $true)
if (-not $function) { throw 'ACL policy function is unavailable.' }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($current, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in $trusted[0..2]) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($sid),
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow))
}
$check = [scriptblock]::Create($function.Extent.Text + [Environment]::NewLine + 'Assert-TrustedAncestorOwner $acl ''synthetic ancestor'' $trusted')
foreach ($sid in $trusted) {
    $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new($sid))
    & $check
}
$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-111111111-222222222-333333333-1001'))
$refused = $false
try { & $check } catch {
    if ($_.Exception.Message -notlike '*ancestor is owned by another principal*') { throw }
    $refused = $true
}
if (-not $refused) { throw 'Restricted DACL concealed unsafe foreign owner.' }
`], { encoding: 'utf8' });
  assert.ifError(descriptorProbe.error);
  assert.equal(descriptorProbe.status, 0, descriptorProbe.stderr || descriptorProbe.stdout);
});

test('an insecure custom profile and substituted junctions refuse startup before any database can open', { skip: windowsOnly }, async (t) => {
  const { root, profilePath, webDist } = profileFixture(t);
  const inherited = join(root, 'insecure');
  mkdirSync(inherited);
  await assert.rejects(startServer({ profilePath: inherited, webDist, port: 0 }), /Private profile security check failed/);
  assert.deepEqual(readdirSync(inherited), []);

  const replaceableParent = join(root, 'replaceable');
  mkdirSync(replaceableParent);
  const grant = spawnSync('icacls.exe', [replaceableParent, '/grant', '*S-1-5-32-545:(OI)(CI)M'], { encoding: 'utf8' });
  assert.equal(grant.status, 0, grant.stderr);
  await assert.rejects(startServer({
    profilePath: join(replaceableParent, 'new-private'), webDist, port: 0,
  }), /ancestor permits another principal to replace/);
  assert.deepEqual(readdirSync(replaceableParent), []);

  const target = join(root, 'target');
  verifyWindowsProfile(target, 'create');
  const substituted = join(root, 'junction');
  symlinkSync(target, substituted, 'junction');
  await assert.rejects(startServer({ profilePath: substituted, webDist, port: 0 }), /reparse-point profile path/);
  const nested = join(profilePath, 'substituted-content');
  symlinkSync(target, nested, 'junction');
  await assert.rejects(startServer({ profilePath, webDist, port: 0 }), /reparse point inside private profile/);
  assert.deepEqual(readdirSync(target), []);
});
