import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOOK_MARKER_BEGIN = '# >>> mileage post-commit hook >>>';
const HOOK_MARKER_END = '# <<< mileage post-commit hook <<<';

const HOOK_SCRIPT_POSIX = `${HOOK_MARKER_BEGIN}
# Installed by Mileage. Auto-syncs metrics after each commit.
# To uninstall: \`mileage uninstall-hook\` (or delete this block).
if command -v mileage >/dev/null 2>&1; then
  ( cd "$(git rev-parse --show-toplevel)" && mileage sync --since 24h >/dev/null 2>&1 & )
fi
${HOOK_MARKER_END}
`;

const HOOK_SCRIPT_WINDOWS = `${HOOK_MARKER_BEGIN}
where mileage >NUL 2>&1
if %errorlevel% equ 0 (
  cd /d "%CD%"
  start /b "" cmd /c "mileage sync --since 24h >NUL 2>&1"
)
${HOOK_MARKER_END}
`;

function isGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--git-dir'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function hookPath(cwd: string): string {
  const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const gitDir = path.isAbsolute(out) ? out : path.join(cwd, out);
  return path.join(gitDir, 'hooks', 'post-commit');
}

export function installPostCommitHook(cwd: string): {
  installed: boolean;
  alreadyPresent: boolean;
  path: string;
  message: string;
} {
  if (!isGitRepo(cwd)) {
    return {
      installed: false,
      alreadyPresent: false,
      path: '',
      message: `Not a git repository: ${cwd}`,
    };
  }
  const hookFile = hookPath(cwd);
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });

  let existing = '';
  if (fs.existsSync(hookFile)) {
    existing = fs.readFileSync(hookFile, 'utf8');
    if (existing.includes(HOOK_MARKER_BEGIN)) {
      return {
        installed: false,
        alreadyPresent: true,
        path: hookFile,
        message: `Mileage hook already installed at ${hookFile}`,
      };
    }
  }

  const isWindows = process.platform === 'win32';
  const script = isWindows ? HOOK_SCRIPT_WINDOWS : HOOK_SCRIPT_POSIX;

  let content: string;
  if (existing.length === 0) {
    content = (isWindows ? '@echo off\n' : '#!/bin/sh\n') + script;
  } else {
    content = existing.endsWith('\n') ? existing + script : existing + '\n' + script;
  }
  fs.writeFileSync(hookFile, content);

  if (!isWindows) {
    try {
      fs.chmodSync(hookFile, 0o755);
    } catch {
      // best-effort
    }
  }

  return {
    installed: true,
    alreadyPresent: false,
    path: hookFile,
    message: `Installed Mileage post-commit hook at ${hookFile}`,
  };
}

export function uninstallPostCommitHook(cwd: string): {
  removed: boolean;
  path: string;
  message: string;
} {
  if (!isGitRepo(cwd)) {
    return { removed: false, path: '', message: `Not a git repository: ${cwd}` };
  }
  const hookFile = hookPath(cwd);
  if (!fs.existsSync(hookFile)) {
    return { removed: false, path: hookFile, message: `No hook file at ${hookFile}` };
  }
  const content = fs.readFileSync(hookFile, 'utf8');
  if (!content.includes(HOOK_MARKER_BEGIN)) {
    return {
      removed: false,
      path: hookFile,
      message: `No Mileage block found in ${hookFile}`,
    };
  }
  const stripped = content.replace(
    new RegExp(`\\s*${HOOK_MARKER_BEGIN}[\\s\\S]*?${HOOK_MARKER_END}\\s*`),
    '\n',
  );
  const trimmed = stripped.trim();
  if (trimmed.length === 0 || trimmed === '#!/bin/sh' || trimmed === '@echo off') {
    fs.unlinkSync(hookFile);
    return {
      removed: true,
      path: hookFile,
      message: `Removed Mileage hook (file was empty otherwise; deleted ${hookFile})`,
    };
  }
  fs.writeFileSync(hookFile, stripped.endsWith('\n') ? stripped : stripped + '\n');
  return {
    removed: true,
    path: hookFile,
    message: `Removed Mileage block from ${hookFile}`,
  };
}
