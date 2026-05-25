import type { ProjectInfo } from '../storage/types';
import { normalizePath } from '../storage/paths';

// Repos to git-scan during sync: every known project minus excluded paths,
// deduped by project hash. Excluded paths are already normalized in config.
export function selectReposToSync(
  known: ProjectInfo[],
  excludedRepos: string[],
): ProjectInfo[] {
  const excluded = new Set(excludedRepos);
  const seen = new Set<string>();
  const out: ProjectInfo[] = [];
  for (const p of known) {
    if (excluded.has(normalizePath(p.path))) continue;
    if (seen.has(p.project_hash)) continue;
    seen.add(p.project_hash);
    out.push(p);
  }
  return out;
}
