/**
 * Risk measures on a return series. Like XIRR and TWR these are ratios, so plain numbers are fine:
 * no money is added up here.
 */

/** Fall from the running peak at each point: level / highest level so far − 1 (0 at a new high, negative below it). */
export function drawdowns(levels: readonly number[]): number[] {
  let peak = -Infinity;
  return levels.map((v) => {
    peak = Math.max(peak, v);
    return peak > 0 ? v / peak - 1 : 0;
  });
}

export interface Drawdown {
  /** The deepest fall, e.g. −0.25 for a 25 % fall. */
  depth: number;
  /** Index of the peak before the fall, of its lowest point, and of the first point back at the peak (if any). */
  peak: number;
  trough: number;
  recovered?: number;
}

/** The deepest peak-to-trough fall, or undefined when the series never falls below a previous high. */
export function maxDrawdown(levels: readonly number[]): Drawdown | undefined {
  const dd = drawdowns(levels);
  let trough = -1;
  dd.forEach((d, i) => {
    if (d < 0 && (trough < 0 || d < dd[trough]!)) trough = i;
  });
  if (trough < 0) return undefined;
  let peak = trough;
  while (peak > 0 && dd[peak]! < 0) peak--;
  const back = dd.findIndex((d, i) => i > trough && d === 0);
  return { depth: dd[trough]!, peak, trough, ...(back >= 0 ? { recovered: back } : {}) };
}

/** Annualized volatility: sample standard deviation of the period returns × √(periods per year). Needs two returns. */
export function volatility(returns: readonly number[], perYear = 12): number | undefined {
  const n = returns.length;
  if (n < 2) return undefined;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance * perYear);
}
