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
