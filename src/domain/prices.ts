import type { Decimal, Ccy } from './money.ts';
import { daysBetween } from './dates.ts';
import type { IsoDate } from './dates.ts';

export interface PricePoint {
  date: IsoDate;
  close: Decimal;
  ccy: Ccy;
  source: string;
}

export interface PriceSource {
  /** Latest close on or before `date`, or undefined if none is fresh enough. Never extrapolates. */
  close(symbol: string, date: IsoDate): PricePoint | undefined;
  /** Every stored close for the symbol, ascending (for charts and ranges). */
  history?(symbol: string): readonly PricePoint[];
}

/** In-memory daily series per symbol. A close older than `maxStaleDays` counts as missing. */
export class SeriesPriceSource implements PriceSource {
  private readonly series = new Map<string, PricePoint[]>();

  private readonly maxStaleDays: number;

  constructor(maxStaleDays = 10) {
    this.maxStaleDays = maxStaleDays;
  }

  set(symbol: string, points: PricePoint[]): this {
    this.series.set(symbol, [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
    return this;
  }

  history(symbol: string): readonly PricePoint[] {
    return this.series.get(symbol) ?? [];
  }

  close(symbol: string, date: IsoDate): PricePoint | undefined {
    const pts = this.series.get(symbol);
    if (!pts) return undefined;
    let lo = 0;
    let hi = pts.length - 1;
    let found: PricePoint | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]!.date <= date) {
        found = pts[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found && daysBetween(found.date, date) <= this.maxStaleDays ? found : undefined;
  }
}
