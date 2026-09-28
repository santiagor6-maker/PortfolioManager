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

/**
 * The Resumen's modules, in the order the user chose, each shown or hidden. Saved as ids in order, a hidden
 * one prefixed with "-" (e.g. "valor,-mix,kpis"). Unknown ids are dropped; modules the saved layout doesn't
 * know yet (added in a later version) are appended, shown.
 */
export interface Slot {
  id: string;
  on: boolean;
}

export function parseLayout(saved: string, ids: readonly string[]): Slot[] {
  const seen = new Set<string>();
  const out: Slot[] = [];
  for (const raw of saved.split(',')) {
    const id = raw.replace(/^-/, '');
    if (!ids.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, on: !raw.startsWith('-') });
  }
  return [...out, ...ids.filter((id) => !seen.has(id)).map((id) => ({ id, on: true }))];
}

export const saveLayout = (slots: readonly Slot[]) => slots.map((s) => (s.on ? s.id : `-${s.id}`)).join(',');

/** Moves a module one place up (−1) or down (+1); at either end nothing changes. */
export function moveSlot(slots: readonly Slot[], i: number, by: -1 | 1): Slot[] {
  const j = i + by;
  if (j < 0 || j >= slots.length) return [...slots];
  const next = [...slots];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Reads a saved selection, dropping portfolios that no longer exist. */
export function parseSelection(saved: string, all: readonly string[]): Selection {
  const ids = saved.split(',').filter((x) => all.includes(x));
  return ids.length === 0 || ids.length === all.length ? null : all.filter((x) => ids.includes(x));
}
