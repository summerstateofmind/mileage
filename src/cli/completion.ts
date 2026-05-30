// Emits shell completion scripts. The command list is passed in (derived live from
// commander in cli.ts) so completions never drift from the real command set.

function pwshScript(cmds: string[]): string {
  const arr = cmds.map((c) => `'${c}'`).join(', ');
  return `# mileage PowerShell completion. Add to your $PROFILE:
#   mileage completion pwsh | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName mileage -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  @(${arr}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}`;
}

function bashScript(cmds: string[]): string {
  const words = cmds.join(' ');
  return `# mileage bash completion. Add to ~/.bashrc:
#   source <(mileage completion bash)
_mileage_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
  # ':' is a bash word-break; strip the pre-colon prefix so judge:enable completes.
  if [[ "$cur" == *:* ]]; then
    local pre="\${cur%:*}:"
    COMPREPLY=( "\${COMPREPLY[@]#$pre}" )
  fi
}
complete -F _mileage_completions mileage`;
}

function zshScript(cmds: string[]): string {
  const arr = cmds.map((c) => `'${c}'`).join(' ');
  return `# mileage zsh completion. Add to ~/.zshrc:
#   source <(mileage completion zsh)
_mileage() {
  local -a cmds
  cmds=(${arr})
  compadd -- $cmds
}
compdef _mileage mileage`;
}

export function completionScript(shell: string, commands: string[]): string | null {
  const cmds = [...new Set(commands.filter(Boolean))].sort();
  switch (shell) {
    case 'pwsh':
    case 'powershell':
      return pwshScript(cmds);
    case 'bash':
      return bashScript(cmds);
    case 'zsh':
      return zshScript(cmds);
    default:
      return null;
  }
}

export type Shell = 'pwsh' | 'bash' | 'zsh';

export const MARKER_START = '# >>> mileage completion >>>';
export const MARKER_END = '# <<< mileage completion <<<';

// Source a freshly-generated script at shell startup rather than embedding a copy,
// so completions track the live command set instead of going stale.
export function sourceLine(shell: Shell): string {
  switch (shell) {
    case 'pwsh':
      return 'mileage completion pwsh | Out-String | Invoke-Expression';
    case 'bash':
      return 'source <(mileage completion bash)';
    case 'zsh':
      return 'source <(mileage completion zsh)';
  }
}

export function completionBlock(shell: Shell): string {
  return `${MARKER_START}\n${sourceLine(shell)}\n${MARKER_END}`;
}

export function detectShell(platform: string, shellEnv: string | undefined): Shell | null {
  if (platform === 'win32') return 'pwsh';
  if (shellEnv) {
    const base = shellEnv.split(/[\\/]/).pop() ?? '';
    if (base.includes('zsh')) return 'zsh';
    if (base.includes('bash')) return 'bash';
  }
  return null;
}

export function normalizeShell(shell: string): Shell | null {
  switch (shell) {
    case 'pwsh':
    case 'powershell':
      return 'pwsh';
    case 'bash':
      return 'bash';
    case 'zsh':
      return 'zsh';
    default:
      return null;
  }
}

// Append the marker block once. If a block is already present, leave the file
// untouched (changed: false) so re-running install is a no-op.
export function addBlock(content: string, shell: Shell): { content: string; changed: boolean } {
  if (content.includes(MARKER_START)) return { content, changed: false };
  const block = completionBlock(shell);
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const lead = content.length === 0 ? '' : '\n';
  return { content: `${content}${sep}${lead}${block}\n`, changed: true };
}

// Strip the marker block (and the blank line that precedes it, if any).
export function removeBlock(content: string): { content: string; changed: boolean } {
  const re = new RegExp(
    `\\n?${escapeRe(MARKER_START)}[\\s\\S]*?${escapeRe(MARKER_END)}\\n?`,
  );
  if (!re.test(content)) return { content, changed: false };
  return { content: content.replace(re, '\n'), changed: true };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
