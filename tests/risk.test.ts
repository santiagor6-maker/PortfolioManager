import { describe, expect, it } from 'vitest';
import { drawdowns, maxDrawdown, volatility } from '../src/domain/risk.ts';

describe('risk measures, hand-verified', () => {
  // Peaks: 100, 120, 120, 120, 130, 130.
  const levels = [100, 120, 90, 108, 130, 117];

  it('drawdown is the fall from the running peak', () => {
    const dd = drawdowns(levels);
    [0, 0, -0.25, -0.1, 0, -0.1].forEach((x, i) => expect(dd[i]).toBeCloseTo(x, 12));
  });

  it('the deepest fall, with its peak, trough and recovery', () => {
    expect(maxDrawdown(levels)).toEqual({ depth: -0.25, peak: 1, trough: 2, recovered: 4 });
  });

  it('a fall not yet recovered has no recovery point; a series that never falls has no drawdown', () => {
    expect(maxDrawdown([100, 80, 90])).toEqual({ depth: expect.closeTo(-0.2, 12), peak: 0, trough: 1 });
    expect(maxDrawdown([1, 2, 3])).toBeUndefined();
    expect(maxDrawdown([])).toBeUndefined();
  });

  it('volatility: sample standard deviation, annualized with √12', () => {
    // mean 0; sample variance (0.01 + 0.01) / 1 = 0.02 → √(0.02 · 12) = 0.4898979…
    expect(volatility([0.1, -0.1])).toBeCloseTo(Math.sqrt(0.24), 12);
    expect(volatility([0.02, 0.02, 0.02])).toBe(0);
    expect(volatility([0.05])).toBeUndefined();
  });
});
