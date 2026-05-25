import * as fs from 'node:fs';
import * as path from 'node:path';
import { mileageDir, normalizePath } from '../storage/paths';
import type { MileageConfig, Plan } from '../storage/types';

const CONFIG_FILE = 'config.json';

export const DEFAULT_CONFIG: MileageConfig = {
  version: 1,
  plan: 'unknown',
  preferences: {
    currency: 'USD',
    show_dollars_anyway: false,
    waste_threshold_usd: 5,
  },
  excluded_repos: [],
  judge: {
    enabled: false,
    model_override: null,
    cloud: { enabled: false, endpoint: '', model: '' },
  },
};

export const VALID_PLANS: Plan[] = [
  'api',
  'pro',
  'max-100',
  'max-200',
  'cursor-pro',
  'copilot',
  'unknown',
];

function configPath(): string {
  return path.join(mileageDir(), CONFIG_FILE);
}

export function readConfig(): MileageConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<MileageConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      preferences: {
        ...DEFAULT_CONFIG.preferences,
        ...(parsed.preferences ?? {}),
      },
      excluded_repos: parsed.excluded_repos ?? DEFAULT_CONFIG.excluded_repos,
      judge: {
        ...DEFAULT_CONFIG.judge,
        ...(parsed.judge ?? {}),
        cloud: { ...DEFAULT_CONFIG.judge.cloud, ...(parsed.judge?.cloud ?? {}) },
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeConfig(cfg: MileageConfig): void {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

export function setPlan(plan: Plan): MileageConfig {
  const cfg = readConfig();
  cfg.plan = plan;
  writeConfig(cfg);
  return cfg;
}

export function planDisplayName(plan: Plan): string {
  switch (plan) {
    case 'api':
      return 'API (pay-per-token)';
    case 'pro':
      return 'Claude Pro ($20/mo)';
    case 'max-100':
      return 'Claude Max — 5× ($100/mo)';
    case 'max-200':
      return 'Claude Max — 20× ($200/mo)';
    case 'cursor-pro':
      return 'Cursor Pro';
    case 'copilot':
      return 'GitHub Copilot';
    case 'unknown':
      return 'Unknown (declare with `mileage config:set-plan <plan>`)';
  }
}

export function isSubscriptionPlan(plan: Plan): boolean {
  return (
    plan === 'pro' ||
    plan === 'max-100' ||
    plan === 'max-200' ||
    plan === 'cursor-pro' ||
    plan === 'copilot'
  );
}

export function isApiPlan(plan: Plan): boolean {
  return plan === 'api';
}

export function withExcludedRepo(cfg: MileageConfig, repoPath: string): MileageConfig {
  const norm = normalizePath(repoPath);
  if (cfg.excluded_repos.includes(norm)) return cfg;
  return { ...cfg, excluded_repos: [...cfg.excluded_repos, norm] };
}

export function withoutExcludedRepo(cfg: MileageConfig, repoPath: string): MileageConfig {
  const norm = normalizePath(repoPath);
  return { ...cfg, excluded_repos: cfg.excluded_repos.filter((x) => x !== norm) };
}

export function addExcludedRepo(repoPath: string): MileageConfig {
  const cfg = withExcludedRepo(readConfig(), repoPath);
  writeConfig(cfg);
  return cfg;
}

export function removeExcludedRepo(repoPath: string): MileageConfig {
  const cfg = withoutExcludedRepo(readConfig(), repoPath);
  writeConfig(cfg);
  return cfg;
}

export function withJudgeEnabled(cfg: MileageConfig, enabled: boolean): MileageConfig {
  return { ...cfg, judge: { ...cfg.judge, enabled } };
}

export function withJudgeCloud(
  cfg: MileageConfig,
  cloud: { enabled: boolean; endpoint: string; model: string },
): MileageConfig {
  return { ...cfg, judge: { ...cfg.judge, cloud } };
}

export function setJudgeEnabled(enabled: boolean): MileageConfig {
  const c = withJudgeEnabled(readConfig(), enabled);
  writeConfig(c);
  return c;
}

export function setJudgeCloud(cloud: { enabled: boolean; endpoint: string; model: string }): MileageConfig {
  const c = withJudgeCloud(readConfig(), cloud);
  writeConfig(c);
  return c;
}
