import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function mileageDir(): string {
  const dir = path.join(os.homedir(), '.mileage');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function mileageDbPath(): string {
  return path.join(mileageDir(), 'metrics.db');
}

export function claudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export function schemaPath(): string {
  return path.join(__dirname, 'schema.sql');
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function projectHashFromPath(absPath: string): string {
  return crypto
    .createHash('sha256')
    .update(normalizePath(absPath))
    .digest('hex')
    .slice(0, 16);
}

export function projectHashFromCwd(cwd: string = process.cwd()): string {
  return projectHashFromPath(cwd);
}

