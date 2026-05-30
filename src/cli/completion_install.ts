import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { addBlock, removeBlock, type Shell } from './completion';

export interface ProfileResult {
  path?: string;
  error?: string;
}

// PowerShell's profile path varies by edition (5.1 vs 7) and can be redirected
// (OneDrive Documents), so we ask PowerShell itself rather than guessing in Node.
function resolvePwshProfile(): ProfileResult {
  for (const exe of ['pwsh', 'powershell']) {
    const res = spawnSync(exe, ['-NoProfile', '-Command', '$PROFILE'], {
      encoding: 'utf8',
    });
    if (res.status === 0 && res.stdout) {
      const p = res.stdout.trim();
      if (p) return { path: p };
    }
  }
  return {
    error:
      'Could not locate your PowerShell $PROFILE. Open PowerShell and run `$PROFILE` to find it, then add this line manually:\n  mileage completion pwsh | Out-String | Invoke-Expression',
  };
}

export function resolveProfilePath(shell: Shell): ProfileResult {
  switch (shell) {
    case 'bash':
      return { path: path.join(os.homedir(), '.bashrc') };
    case 'zsh':
      return { path: path.join(os.homedir(), '.zshrc') };
    case 'pwsh':
      return resolvePwshProfile();
  }
}

export interface InstallOutcome {
  path: string;
  changed: boolean;
  error?: string;
}

function readIfExists(p: string): string {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

export function installCompletion(shell: Shell): InstallOutcome {
  const resolved = resolveProfilePath(shell);
  if (!resolved.path) return { path: '', changed: false, error: resolved.error };

  const current = readIfExists(resolved.path);
  const { content, changed } = addBlock(current, shell);
  if (changed) {
    fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
    fs.writeFileSync(resolved.path, content);
  }
  return { path: resolved.path, changed };
}

export function uninstallCompletion(shell: Shell): InstallOutcome {
  const resolved = resolveProfilePath(shell);
  if (!resolved.path) return { path: '', changed: false, error: resolved.error };

  const current = readIfExists(resolved.path);
  const { content, changed } = removeBlock(current);
  if (changed) fs.writeFileSync(resolved.path, content);
  return { path: resolved.path, changed };
}

export function reloadHint(shell: Shell, profilePath: string): string {
  switch (shell) {
    case 'pwsh':
      return `. "${profilePath}"`;
    case 'bash':
      return 'source ~/.bashrc';
    case 'zsh':
      return 'source ~/.zshrc';
  }
}
