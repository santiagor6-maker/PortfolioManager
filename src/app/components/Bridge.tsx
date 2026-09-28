export interface BridgeStep {
  label: string;
  /** A total is drawn from zero; a step floats from the running total to running total + value. */
  kind: 'total' | 'step';
  value: number;
  color: string;
  /** Text at the bar end. */
  text: string;
  title?: string;
}

/**
 * Horizontal waterfall ("puente"): the start value, what moved it step by step, and the end value.
 * Each bar floats from where the previous one ended; values sit at the bar end, outside the mark.
 */
export function Bridge({ steps, label, pad = 76 }: { steps: BridgeStep[]; label: string; pad?: number }) {
  let run = 0;
  const spans = steps.map((s) => {
    const a = s.kind === 'total' ? 0 : run;
    const b = s.kind === 'total' ? s.value : run + s.value;
    run = b;
    return [Math.min(a, b), Math.max(a, b), b < a] as const;
  });
  const lo = Math.min(0, ...spans.map((s) => s[0]));
  const hi = Math.max(0, ...spans.map((s) => s[1]));
  const span = hi - lo || 1;
  const at = (v: number) => ((v - lo) / span) * 100;
  return (
    <div class="bars waterfall" role="list" aria-label={label}>
      {steps.map((s, i) => {
        const [a, b, down] = spans[i]!;
        const left = at(a);
        const w = Math.max(at(b) - left, 0.6);
        return (
          <div class={`bar-row wf-${s.kind}`} role="listitem" title={s.title}>
            <span class="bar-label">{s.label}</span>
            <span class="track" style={`margin-left:${lo < 0 ? pad : 0}px;margin-right:${pad}px`}>
              {lo < 0 && <span class="zero" style={`left:${at(0)}%`} />}
              <span class="fill" style={`left:${left}%;width:${w}%;background:${s.color}`} />
              <span class="tipv" style={down ? `right:calc(${100 - left}% + 5px)` : `left:calc(${left + w}% + 5px)`}>
                {s.text}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
