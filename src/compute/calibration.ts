import { DatabaseSync } from 'node:sqlite';
import {
  getActiveCalibration,
  setActiveCalibration,
  upsertCalibration,
} from '../storage/db';
import type { Calibration } from '../storage/types';

export const CURRENT_VERSION = 'YPT-2026.1';

const PRIOR: Omit<Calibration, 'created_at' | 'active'> = {
  version: CURRENT_VERSION,
  mu: Math.log(0.5),
  sigma: 1.26,
  n_prior: 100,
  anchor: 'P50→50, P10→90',
  source: 'v0 literature prior (Lighthouse two-point; benchmark median guess)',
};

export function standardNormalCdf(z: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y =
    1 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export function inverseStandardNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error(`inverseStandardNormalCdf out of range: ${p}`);
  }
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

export function scoreYieldRate(
  yieldRate: number,
  mu: number,
  sigma: number,
): number {
  if (yieldRate <= 0) return 0;
  if (sigma <= 0) return 50;
  const z = (Math.log(yieldRate) - mu) / sigma;
  return Math.max(0, Math.min(100, 100 * standardNormalCdf(z)));
}

export function anchorTwoPoint(
  yieldA: number,
  scoreA: number,
  yieldB: number,
  scoreB: number,
): { mu: number; sigma: number } {
  if (yieldA <= 0 || yieldB <= 0)
    throw new Error('yield rates must be positive');
  if (scoreA === scoreB) throw new Error('anchor scores must differ');
  const zA = inverseStandardNormalCdf(scoreA / 100);
  const zB = inverseStandardNormalCdf(scoreB / 100);
  const sigma = (Math.log(yieldB) - Math.log(yieldA)) / (zB - zA);
  const mu = Math.log(yieldA) - sigma * zA;
  return { mu, sigma };
}

export function madSigma(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = sorted
    .map((v) => Math.abs(v - median))
    .sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  return 1.4826 * mad;
}

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface ShrinkInput {
  mu: number;
  sigma: number;
  n_prior: number;
}

export interface EmpiricalEstimate {
  mu: number;
  sigma: number;
  n: number;
}

export function shrinkCalibration(
  prior: ShrinkInput,
  empirical: EmpiricalEstimate | null,
): { mu: number; sigma: number; source: string } {
  if (!empirical || empirical.n === 0) {
    return {
      mu: prior.mu,
      sigma: prior.sigma,
      source: 'pure prior (N=0)',
    };
  }
  const wPrior = prior.n_prior / (prior.n_prior + empirical.n);
  const wEmp = empirical.n / (prior.n_prior + empirical.n);
  const mu = wPrior * prior.mu + wEmp * empirical.mu;
  const sigmaEmp = empirical.sigma > 0 ? empirical.sigma : prior.sigma;
  const sigma = wPrior * prior.sigma + wEmp * sigmaEmp;
  return {
    mu,
    sigma,
    source: `shrunken (N_prior=${prior.n_prior}, N_emp=${empirical.n}, w_prior=${wPrior.toFixed(2)})`,
  };
}

export function ensureCalibration(db: DatabaseSync): Calibration {
  const existing = getActiveCalibration(db);
  if (existing) return existing;
  const seeded: Calibration = {
    ...PRIOR,
    created_at: Date.now(),
    active: true,
  };
  upsertCalibration(db, seeded);
  setActiveCalibration(db, seeded.version);
  return seeded;
}
