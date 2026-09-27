/**
 * Which portfolios the Resumen adds up, as the ids of asset classes plus `cash`; `null` is everything.
 * A plain click shows only that portfolio (clicking it again shows everything); Ctrl/⌘-click adds or removes it.
 */
export type Selection = string[] | null;

export const CASH = 'cash';

export function pick(current: Selection, id: string, all: readonly string[], additive: boolean): Selection {
  const cur = current ?? all;
  const next = additive ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : cur.length === 1 && cur[0] === id ? [...all] : [id];
  const ordered = all.filter((x) => next.includes(x));
  return ordered.length === 0 || ordered.length === all.length ? null : ordered;
}

/** Reads a saved selection, dropping portfolios that no longer exist. */
export function parseSelection(saved: string, all: readonly string[]): Selection {
  const ids = saved.split(',').filter((x) => all.includes(x));
  return ids.length === 0 || ids.length === all.length ? null : all.filter((x) => ids.includes(x));
}
