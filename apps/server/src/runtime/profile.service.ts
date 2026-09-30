import { Injectable } from '@nestjs/common';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

interface OwnerRecord { pid: number; instanceId: string }
interface DiscoveryRecord extends OwnerRecord {
  version: 1;
  profile: string;
  origin: string;
  bearer?: string;
  launcherToken?: string;
}

export interface BridgeDiscovery {
  origin: string;
  bearer: string;
  instanceId: string;
}

const serverPackageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceRoot = realpathSync.native(resolve(serverPackageRoot, '../..'));
const aclScript = join(serverPackageRoot, 'scripts', 'profile-acl.ps1');
const lockName = 'owner.lock';
const recoveryName = '.owner-recovery';
const execFileAsync = promisify(execFile);
const aclOptions = {
  windowsHide: true,
  encoding: 'utf8' as const,
  stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
  maxBuffer: 256 * 1024,
};
function profileCheckArgs(path: string, action: 'create' | 'verify'): string[] {
  if (process.platform !== 'win32') {
    throw new Error('Private profile ACL verification requires Windows; refusing to start without a supported local security boundary.');
  }
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', aclScript, '-Action', action, '-ProfilePath', path];
}
function profileCheckFailure(error: unknown): Error {
  const failure = error as Error & { stderr?: string };
  return new Error(`Private profile security check failed: ${failure.stderr?.trim() || failure.message}`);
}

export function resolveProfilePath(customPath = process.env.ASSETWEAVE_DATA_DIR): string {
  const chosen = customPath || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'AssetWeave'));
  if (!chosen) throw new Error('LOCALAPPDATA is unavailable. Set ASSETWEAVE_DATA_DIR to a private local directory.');
  const path = resolve(chosen);
  if (path === parse(path).root) throw new Error('The AssetWeave profile cannot be a drive root.');
  const fromSource = relative(sourceRoot.toLowerCase(), path.toLowerCase());
  if (fromSource === '' || (fromSource !== '..' && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource))) {
    throw new Error('The AssetWeave profile must be outside the project source tree. Choose a private local directory.');
  }
  return path;
}

export function verifyWindowsProfile(path: string, action: 'create' | 'verify'): void {
  const args = profileCheckArgs(path, action);
  try {
    execFileSync('powershell.exe', args, aclOptions);
  } catch (error) {
    throw profileCheckFailure(error);
  }
}

export async function verifyWindowsProfileAsync(path: string, action: 'create' | 'verify'): Promise<void> {
  const args = profileCheckArgs(path, action);
  try {
    await execFileAsync('powershell.exe', args, aclOptions);
  } catch (error) {
    throw profileCheckFailure(error);
  }
}

function isProcessPresent(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Owner lock has no valid PID; cannot confirm its owner is absent.');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // EPERM and unknown probe errors do not establish that a process is gone.
    return true;
  }
}

function readOwner(path: string): OwnerRecord {
  const data = readFileSync(path, { encoding: 'utf8' });
  if (data.length > 2048) throw new Error('Owner lock is malformed; cannot establish that its owner is absent.');
  let record: unknown;
  try {
    record = JSON.parse(data);
  } catch {
    throw new Error('Owner lock is malformed; cannot establish that its owner is absent.');
  }
  if (!record || typeof record !== 'object' || !('pid' in record) || !('instanceId' in record) ||
      typeof record.pid !== 'number' || typeof record.instanceId !== 'string') {
    throw new Error('Owner lock is malformed; cannot establish that its owner is absent.');
  }
  return { pid: record.pid, instanceId: record.instanceId };
}

function writeNewLock(path: string, record: OwnerRecord): void {
  const handle = openSync(path, 'wx', 0o600);
  let finished = false;
  try {
    writeFileSync(handle, JSON.stringify(record), 'utf8');
    fsyncSync(handle);
    finished = true;
  } finally {
    closeSync(handle);
    if (!finished) unlinkSync(path);
  }
}

@Injectable()
export class ProfileService {
  readonly path: string;
  readonly instanceId = randomUUID();
  private ownsLock = false;

  private constructor(path: string) {
    this.path = path;
  }

  static open(customPath?: string): ProfileService {
    const candidate = resolveProfilePath(customPath);
    verifyWindowsProfile(candidate, 'create');
    const profile = new ProfileService(realpathSync.native(candidate));
    try {
      profile.acquire();
      profile.verify();
      for (const name of ['artwork', 'staging']) mkdirSync(join(profile.path, name), { recursive: true });
      profile.verify();
      return profile;
    } catch (error) {
      profile.close();
      throw error;
    }
  }

  verify(): void {
    verifyWindowsProfile(this.path, 'verify');
  }
  verifyAsync(): Promise<void> {
    return verifyWindowsProfileAsync(this.path, 'verify');
  }

  private acquire(): void {
    const lock = join(this.path, lockName);
    const owner = { pid: process.pid, instanceId: this.instanceId };
    try {
      writeNewLock(lock, owner);
      this.ownsLock = true;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    this.verify();
    const previousOwner = readOwner(lock);
    if (isProcessPresent(previousOwner.pid)) {
      throw new Error(`Profile is already owned by live process ${previousOwner.pid}. Stop it before starting another service.`);
    }
    // Only one contender may inspect and reclaim a dead owner. An abandoned
    // recovery gate fails closed; it must not be raced or silently broken.
    const gate = join(this.path, recoveryName);
    try {
      mkdirSync(gate);
    } catch {
      throw new Error('Profile ownership recovery is in progress. Wait for it to finish or inspect the abandoned recovery gate.');
    }
    try {
      this.verify();
      const previous = readOwner(lock);
      if (isProcessPresent(previous.pid)) throw new Error(`Profile is already owned by live process ${previous.pid}. Stop it before starting another service.`);
      const latest = readOwner(lock);
      if (latest.pid !== previous.pid || latest.instanceId !== previous.instanceId) {
        throw new Error('Profile owner changed during stale-lock recovery; refusing to overwrite it.');
      }
      unlinkSync(lock);
      writeNewLock(lock, owner);
      this.ownsLock = true;
    } finally {
      rmdirSync(gate);
    }
  }

  private writePrivate(name: string, record: DiscoveryRecord): void {
    const target = join(this.path, name);
    const temporary = join(this.path, `${name}.${this.instanceId}.new`);
    const handle = openSync(temporary, 'wx', 0o600);
    try {
      try {
        writeFileSync(handle, JSON.stringify(record), 'utf8');
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temporary, target);
      this.verify();
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }

  publishDiscovery(origin: string, bearer: string, launcherToken: string): void {
    if (!this.ownsLock) throw new Error('Cannot publish credentials without owning the profile.');
    this.verify();
    const common = { version: 1 as const, profile: this.path, origin, pid: process.pid, instanceId: this.instanceId };
    this.writePrivate('bridge.json', { ...common, bearer });
    this.writePrivate('launcher.json', { ...common, launcherToken });
  }

  private readDiscoveryRecord(name: 'launcher.json' | 'bridge.json'): DiscoveryRecord {
    const raw: unknown = JSON.parse(readFileSync(join(this.path, name), 'utf8'));
    const record = raw as Partial<DiscoveryRecord> | null;
    const owner = readOwner(join(this.path, lockName));
    if (!record || record.version !== 1 || record.profile !== this.path ||
        typeof record.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(record.origin) ||
        Number(new URL(record.origin).port) > 65535 ||
        record.pid !== owner.pid || record.instanceId !== owner.instanceId ||
        !isProcessPresent(owner.pid)) {
      throw new Error('Discovery is invalid or belongs to a stopped or different profile service.');
    }
    return record as DiscoveryRecord;
  }

  readLauncher(): { origin: string; launcherToken: string } {
    this.verify();
    const record = this.readDiscoveryRecord('launcher.json');
    if (!record.launcherToken || !/^[\w-]{43}$/.test(record.launcherToken)) {
      throw new Error('Launcher discovery is invalid. Start the service for the selected profile first.');
    }
    return { origin: record.origin, launcherToken: record.launcherToken };
  }

  async readBridge(): Promise<BridgeDiscovery> {
    await this.verifyAsync();
    const record = this.readDiscoveryRecord('bridge.json');
    if (!record.bearer || !/^[\w-]{43}$/.test(record.bearer)) {
      throw new Error('Bridge discovery is invalid. Start the service for the selected profile first.');
    }
    return { origin: record.origin, bearer: record.bearer, instanceId: record.instanceId };
  }

  static forDiscovery(customPath?: string): ProfileService {
    const candidate = resolveProfilePath(customPath);
    verifyWindowsProfile(candidate, 'verify');
    return new ProfileService(realpathSync.native(candidate));
  }
  static async forBridgeDiscovery(customPath?: string): Promise<ProfileService> {
    const candidate = resolveProfilePath(customPath);
    await verifyWindowsProfileAsync(candidate, 'verify');
    return new ProfileService(realpathSync.native(candidate));
  }

  close(): void {
    if (!this.ownsLock) return;
    const lock = join(this.path, lockName);
    try {
      if (!existsSync(lock) || readOwner(lock).instanceId !== this.instanceId) return;
      for (const name of ['bridge.json', 'launcher.json']) {
        const file = join(this.path, name);
        if (!existsSync(file) || statSync(file).size > 2048) continue;
        try {
          const record = JSON.parse(readFileSync(file, 'utf8')) as Partial<DiscoveryRecord>;
          if (record.instanceId === this.instanceId) unlinkSync(file);
        } catch { /* Leave unexpected files intact rather than deleting another process's state. */ }
      }
      unlinkSync(lock);
    } finally {
      this.ownsLock = false;
    }
  }
}
