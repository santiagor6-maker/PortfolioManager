import type { ComponentChildren } from 'preact';

/** Fixed categorical slot per asset class: a class keeps its color whatever is filtered or how the list is sorted. */
const CLASS_SLOT: Record<string, string> = {
  acciones_usd: 'var(--s1)',
  acciones_cop: 'var(--s2)',
  fondos: 'var(--s3)',
  cripto: 'var(--s4)',
  inmobiliario: 'var(--s5)',
  renta_fija: 'var(--s6)',
};
export const CLASS_ORDER = Object.keys(CLASS_SLOT);
export const classColor = (bucket: string) => CLASS_SLOT[bucket] ?? 'var(--s7)';
export const byClassOrder = (a: string, b: string) => (CLASS_ORDER.indexOf(a) + 1 || 99) - (CLASS_ORDER.indexOf(b) + 1 || 99);

export interface Part {
  id: string;
  label: string;
  value: number;
  color: string;
  detail: ComponentChildren;
}

/**
 * Part-to-whole: one 100% bar (segments in fixed slot order, 2px surface gaps) plus a legend carrying every value.
 * With `onPick` the legend items are buttons; parts where `isOn` is false stay in the legend but leave the bar.
 */
export function StackedBar({ parts, label, isOn = () => true, onPick }: { parts: Part[]; label: string; isOn?: (id: string) => boolean; onPick?: (id: string, e: MouseEvent) => void }) {
  const shown = parts.filter((p) => isOn(p.id));
  const total = shown.reduce((s, p) => s + Math.max(0, p.value), 0) || 1;
  return (
    <div>
      <div class="alloc-bar" role="img" aria-label={label}>
        {shown
          .filter((p) => p.value > 0)
          .map((p) => (
            <span style={`flex:${p.value / total};background:${p.color}`} title={`${p.label}: ${((100 * p.value) / total).toFixed(1)} %`} />
          ))}
      </div>
      <div class="alloc-legend">
        {parts.map((p) =>
          onPick ? (
            <button type="button" class={`item pick ${isOn(p.id) ? '' : 'off'}`} aria-pressed={isOn(p.id)} onClick={(e) => onPick(p.id, e)}>
              <span class="dot" style={`background:${p.color}`} />
              <span class="name">{p.label}</span>
              <span class="val">{p.detail}</span>
            </button>
          ) : (
            <div class="item">
              <span class="dot" style={`background:${p.color}`} />
              <span class="name">{p.label}</span>
              <span class="val">{p.detail}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export interface BarItem {
  label: string;
  value: number;
  color: string;
  /** Text shown at the bar tip. */
  text: string;
  title?: string;
}

/** Horizontal bars from a shared zero line (negatives extend left), value at the tip. */
/** `pad`: px kept free beside the bars for the value text (longer texts need more). */
export function BarList({ items, label, pad = 66 }: { items: BarItem[]; label: string; pad?: number }) {
  const lo = Math.min(0, ...items.map((i) => i.value));
  const hi = Math.max(0, ...items.map((i) => i.value));
  const span = hi - lo || 1;
  // The track keeps fixed margins for the value text: right of positives, left of negatives.
  const scale = (v: number) => (v / span) * 100;
  const zero = (-lo / span) * 100;
  const margins = `margin-left:${lo < 0 ? pad : 0}px;margin-right:${hi > 0 ? pad + 2 : 0}px`;
  return (
    <div class="bars" role="list" aria-label={label}>
      {items.map((i) => {
        const w = Math.abs(scale(i.value));
        const neg = i.value < 0;
        const left = neg ? zero - w : zero;
        return (
          <div class="bar-row" role="listitem" title={i.title}>
            <span class="bar-label">{i.label}</span>
            <span class="track" style={margins}>
              <span class={`fill ${neg ? 'neg' : ''}`} style={`left:${left}%;width:${Math.max(w, 0.6)}%;background:${i.color}`} />
              {lo < 0 && <span class="zero" style={`left:${zero}%`} />}
              <span class="tipv" style={neg ? `right:calc(${100 - left}% + 5px)` : `left:calc(${left + w}% + 5px)`}>
                {i.text}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
