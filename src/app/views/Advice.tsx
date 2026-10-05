import { useMemo, useState } from 'preact/hooks';
import type { InvestorProfile } from '../../data/json.ts';
import type { Decimal } from '../../domain/money.ts';
import { CLASS_LABEL, CRISIS, decimalOr, DEFAULT_POLICY, HOME, LAG_PME, LEAD_PME, MIN_YEARS, PRESETS, RISK_YEARS, advise, band, profileProblem, presetProfile } from '../advice.ts';
import type { Action, Advice as Report, ClassRecord, RiskLevel } from '../advice.ts';
import { contextOf } from '../context.ts';
import { Filters, useFilters } from '../components/Filters.tsx';
import { date, money, moneyShort, parseNumber, pct, ratio, today } from '../format.ts';
import { REAL_ESTATE } from '../tracking.ts';
import { getDataset, setDataset, useDataset } from '../store.ts';

const sign = (x: number | undefined) => (x === undefined ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const PRIORITY_LABEL = { alta: 'Prioridad alta', media: 'Prioridad media', baja: 'Para tener en cuenta' } as const;
const PRIORITY_CLASS = { alta: 'err', media: 'warn', baja: '' } as const;
const PLAN_LABEL = { vivir: 'para vivir', arrendar: 'para arrendar', vender: 'para vender o ceder' } as const;

/** Orientación: the investor's policy, the diagnosis against it and against the indexes, and the action plan. */
export function Advice() {
  const { data } = useDataset();
  const [f, set] = useFilters();
  const ctx = contextOf(data);
  const a = useMemo(() => {
    try {
      return advise(ctx, f.ccy, f.asOf, data.profile);
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }, [ctx, f.ccy, f.asOf, data.profile]);
  if (a instanceof Error) {
    return (
      <>
        <Filters state={f} set={set} showWindow={false} />
        <div class="notice err">No se pudo armar la orientación con estos datos: {a.message}</div>
      </>
    );
  }
  return <AdviceView a={a} />;
}

function AdviceView({ a }: { a: Report }) {
  const { data } = useDataset();
  const [f, set] = useFilters();
  const [editing, setEditing] = useState(false);
  const v = (x: Decimal) => money(a.toView(x), f.ccy);
  const short = (x: Decimal) => moneyShort(a.toView(x), f.ccy);
  const high = a.actions.filter((x) => x.priority === 'alta').length;
  // What to act on first stays open; the minor points (low priority, or going well) fold under one line.
  const main = a.actions.filter((x) => x.priority !== 'baja' && !x.good);
  const minor = a.actions.filter((x) => x.priority === 'baja' || x.good);
  const usd = a.records.find((r) => r.bucket === 'acciones_usd') ?? a.records[0];

  return (
    <>
      <Filters state={f} set={set} showWindow={false} />
      {a.error && <div class="notice err">{a.error}</div>}

      <section class="card advice-intro">
        <div class="kicker">Orientación</div>
        <h2>Tu plan de acción</h2>
        <p class="small muted">
          Un diagnóstico de tu portafolio con tus propios datos: cómo le fue a cada parte frente a su índice con el mismo dinero, qué tan concentrado y líquido estás, qué necesitas
          apartar para pagos cercanos y qué tan lejos estás de la mezcla que elegiste. Cada punto muestra las cifras en las que se basa. Es orientación general, no asesoría
          personalizada de un asesor registrado ante la Superintendencia Financiera: no predice precios ni recomienda comprar una acción en particular.
          {f.ccy !== a.home && ' Las decisiones se toman en pesos, la moneda en que gastas; en dólares las cifras se convierten a la tasa del corte.'}
        </p>
        {a.top.length > 0 && (
          <div class="top-actions">
            <strong>Empieza por aquí</strong>
            <ol>
              {a.top.map((x) => (
                <li>
                  <a
                    href="#/orientacion"
                    onClick={(e) => {
                      e.preventDefault();
                      document.querySelector(`[data-id="${x.id}"]`)?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    {x.title}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <div class="tiles">
        <div class="tile">
          <div>
            <div class="label">Patrimonio neto</div>
            <div class="value">{short(a.netWorth)}</div>
            <div class="sub">Al {date(f.asOf)}, con la finca raíz neta de lo que debes</div>
          </div>
        </div>
        <div class="tile">
          <div>
            <div class="label">Portafolio líquido</div>
            <div class="value">{short(a.liquid)}</div>
            <div class="sub">
              Todo menos la finca raíz
              {a.reserve?.held.gt(0) ? ` · ${short(a.reserve.held)} apartados para el inmueble` : ` · efectivo ${pct(a.liquid.isZero() ? undefined : a.cash.div(a.liquid).toNumber(), 0)}`}
            </div>
          </div>
        </div>
        {a.realEstate && (
          <div class="tile">
            <div>
              <div class="label">En finca raíz</div>
              <div class={`value ${a.realEstate.share > a.policy.maxRealEstate ? 'neg' : ''}`}>{pct(a.realEstate.share, 0)}</div>
              <div class="sub">
                Del patrimonio · límite {pct(a.policy.maxRealEstate, 0)}
                {a.realEstate.owed.gt(0) ? ` · debes ${short(a.realEstate.owed)}` : ''}
              </div>
            </div>
          </div>
        )}
        {usd && (
          <div class="tile">
            <div>
              <div class="label">
                {usd.label} frente al {usd.bench.name}
              </div>
              <div class={`value ${sign(usd.gap.toNumber())}`}>{`${usd.gap.gt(0) ? '+' : usd.gap.lt(0) ? '−' : ''}${short(usd.gap.abs())}`}</div>
              <div class="sub">Lo que tienes de más o de menos que con el mismo dinero en el índice</div>
            </div>
          </div>
        )}
      </div>

      <section class="card" aria-labelledby="perfil-h">
        <div class="card-head">
          <h2 id="perfil-h">Tu perfil</h2>
          {data.profile && !editing && (
            <button type="button" onClick={() => setEditing(true)}>
              Editar
            </button>
          )}
        </div>
        {data.profile && !editing ? (
          <ProfileSummary p={data.profile} />
        ) : (
          <ProfileForm initial={data.profile} owes={!!a.realEstate?.owed.gt(0)} classes={a.mix.map((r) => r.cls)} onDone={() => setEditing(false)} />
        )}
      </section>

      <section class="card" aria-labelledby="plan-h">
        <div class="card-head">
          <h2 id="plan-h">Qué hacer, en orden</h2>
          <span class="small muted">
            {a.actions.length} {a.actions.length === 1 ? 'punto' : 'puntos'} · {high} de prioridad alta
          </span>
        </div>
        <ol class="actions-list">
          {main.map((x, i) => (
            <ActionCard x={x} n={i + 1} />
          ))}
        </ol>
        {minor.length > 0 && (
          <details class="minor-actions">
            <summary>
              Otros {minor.length} {minor.length === 1 ? 'punto' : 'puntos'} para tener en cuenta ({minor.map((x) => x.area).filter((x, i, all) => all.indexOf(x) === i).join(', ')})
            </summary>
            <ol class="actions-list" start={main.length + 1}>
              {minor.map((x, i) => (
                <ActionCard x={x} n={main.length + i + 1} />
              ))}
            </ol>
          </details>
        )}
      </section>

      {a.mix.length > 0 && <MixCard a={a} v={v} />}
      {a.records.map((r) => (
        <RecordCard r={r} v={v} />
      ))}
      <RiskCard a={a} />
      <Method />
    </>
  );
}

function ActionCard({ x, n }: { x: Action; n: number }) {
  return (
    <li class={`action ${x.priority}${x.good ? ' good' : ''}`} data-id={x.id}>
      <div class="action-head">
        <span class="action-n">{n}</span>
        <div>
          <div class="action-tags">
            <span class={`badge ${x.good ? 'good' : PRIORITY_CLASS[x.priority]}`}>{x.good ? 'Va bien' : PRIORITY_LABEL[x.priority]}</span>
            <span class="badge">{x.area}</span>
          </div>
          <h3>{x.title}</h3>
        </div>
      </div>
      <p>{x.finding}</p>
      <p class="todo">
        <strong>Qué hacer: </strong>
        {x.action}
      </p>
      {(x.why || x.caveat || x.evidence.length > 0) && (
        <details class="small">
          <summary>Por qué, las cifras y los límites</summary>
          {x.why && <p class="muted">Por qué: {x.why}</p>}
          {x.evidence.length > 0 && (
            <table class="compact">
              <tbody>
                {x.evidence.map((e) => (
                  <tr>
                    <th scope="row">{e.label}</th>
                    <td>{e.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {x.caveat && <p class="muted">Ojo: {x.caveat}</p>}
        </details>
      )}
    </li>
  );
}

function ProfileSummary({ p }: { p: InvestorProfile }) {
  const targets = Object.entries(p.targets).filter(([, w]) => w > 0);
  const monthly = decimalOr(p.monthly);
  const funding = decimalOr(p.commitmentFunding);
  return (
    <div class="profile-summary small">
      <p>
        Horizonte <strong>{p.horizonYears} años</strong> · caída que aguantas <strong>{pct(p.maxDrawdown, 0)}</strong> · fondo de emergencia{' '}
        <strong>{p.emergencyMonths === undefined ? 'sin registrar' : `${p.emergencyMonths} meses${decimalOr(p.expenses) ? ` (${money(decimalOr(p.expenses)!.times(p.emergencyMonths), HOME)} con tus gastos, fuera del portafolio)` : ''}`}</strong> · aporte mensual{' '}
        <strong>{monthly ? money(monthly, p.monthlyCcy ?? HOME) : 'sin registrar'}</strong>
      </p>
      <p>
        Máximo por acción <strong>{pct(p.maxPosition, 0)}</strong> · máximo en finca raíz <strong>{pct(p.maxRealEstate, 0)}</strong>
        {p.propertyPlan && (
          <>
            {' '}
            · inmueble <strong>{PLAN_LABEL[p.propertyPlan]}</strong>
          </>
        )}
        {p.commitmentDue && (
          <>
            {' '}
            · saldo al <strong>{date(p.commitmentDue)}</strong>, cubierto por fuera <strong>{funding ? money(funding, HOME) : 'sin registrar'}</strong>
          </>
        )}
      </p>
      {(p.income || p.mortgageRate !== undefined || p.rent) && (
        <p>
          {p.income && <>Ingreso <strong>{money(decimalOr(p.income), HOME)}</strong> · gastos <strong>{p.expenses ? money(decimalOr(p.expenses), HOME) : 'sin registrar'}</strong></>}
          {p.mortgageRate !== undefined && <> · crédito a <strong>{pct(p.mortgageRate, 1)} E.A.</strong>{p.mortgageYears ? <> por <strong>{p.mortgageYears} años</strong></> : ''}</>}
          {p.rent && <> · arriendo esperado <strong>{money(decimalOr(p.rent), HOME)}</strong></>}
        </p>
      )}
      <p>Mezcla objetivo del portafolio líquido: {targets.map(([c, w]) => `${CLASS_LABEL(c)} ${pct(w, 0)}`).join(' · ')}</p>
      <p class="muted">Actualizado el {date(p.updatedAt)}. Revísalo al menos una vez al año.</p>
    </div>
  );
}

/** A typed amount: "1.000.000", "1,000,000", "1000000,5" or "1.000.000,5"; undefined when it is not a number. */
function amountIn(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  try {
    return (/^\d{1,3}(\.\d{3})+$/.test(t) ? parseNumber(t.replace(/\./g, '')) : parseNumber(t))?.toString();
  } catch {
    return undefined;
  }
}

const pctIn = (x: number | undefined) => (x === undefined ? '' : String(Math.round(x * 1000) / 10).replace('.', ','));

function ProfileForm({ initial, owes, classes, onDone }: { initial?: InvestorProfile; owes: boolean; classes: string[]; onDone: () => void }) {
  const [p, setP] = useState<InvestorProfile>(() => initial ?? presetProfile('crecimiento', today()));
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string>();
  const all = [...new Set([...Object.keys(PRESETS.crecimiento.targets), ...classes, ...Object.keys(p.targets)])].filter((c) => c !== REAL_ESTATE);
  const total = all.reduce((s, c) => s + (p.targets[c] ?? 0), 0);
  const typed = (k: string, x: string) => setRaw((r) => ({ ...r, [k]: x }));
  const fraction = (k: string, x: string, apply: (n: number) => void) => {
    typed(k, x);
    const n = amountIn(x);
    apply(n !== undefined ? Number(n) / 100 : x.trim() ? NaN : 0);
  };
  const amount = (k: string, x: string) => {
    typed(k, x);
    return x.trim() ? amountIn(x) ?? 'x' : undefined;
  };
  const shown = (k: string, x: number | undefined) => raw[k] ?? pctIn(x);

  async function save(e: Event) {
    e.preventDefault();
    const next = { ...p, monthlyCcy: HOME, updatedAt: today() };
    const problem = profileProblem(next);
    if (problem) {
      setMsg(problem);
      return;
    }
    await setDataset({ ...getDataset(), profile: next });
    onDone();
  }

  return (
    <form class="profile-form" onSubmit={save}>
      <p class="small muted">
        Empieza con la plantilla más cercana a ti y ajusta cada cifra; son puntos de partida, no una recomendación. Lo que escribas queda en tus datos (y en tu copia cifrada de la
        nube).
      </p>
      <div class="seg" role="group" aria-label="Plantilla">
        {(Object.keys(PRESETS) as RiskLevel[]).map((k) => (
          <button
            type="button"
            onClick={() => {
              const t = presetProfile(k, today());
              setP({ ...p, horizonYears: t.horizonYears, maxDrawdown: t.maxDrawdown, targets: t.targets });
              setRaw({});
            }}
          >
            {PRESETS[k].label}
          </button>
        ))}
      </div>
      <div class="profile-grid">
        <label>
          Horizonte (años)
          <input
            inputMode="numeric"
            value={raw.h ?? String(p.horizonYears)}
            onInput={(e) => {
              const x = (e.target as HTMLInputElement).value;
              typed('h', x);
              setP({ ...p, horizonYears: Number(amountIn(x) ?? 0) });
            }}
          />
        </label>
        <label>
          Caída que aguantarías sin vender (%)
          <input inputMode="decimal" value={shown('dd', p.maxDrawdown)} onInput={(e) => fraction('dd', (e.target as HTMLInputElement).value, (x) => setP({ ...p, maxDrawdown: x }))} />
        </label>
        <label>
          Aporte mensual (COP)
          <input inputMode="decimal" value={raw.mo ?? p.monthly ?? ''} placeholder="0" onInput={(e) => setP({ ...p, monthly: amount('mo', (e.target as HTMLInputElement).value) })} />
        </label>
        <label>
          Meses de gastos fuera del portafolio (fondo de emergencia)
          <input
            inputMode="numeric"
            value={raw.em ?? (p.emergencyMonths === undefined ? '' : String(p.emergencyMonths))}
            onInput={(e) => {
              const x = (e.target as HTMLInputElement).value;
              typed('em', x);
              setP({ ...p, emergencyMonths: x.trim() ? Number(amountIn(x) ?? NaN) : undefined });
            }}
          />
        </label>
        <label>
          Ingreso mensual del hogar, neto (COP)
          <input inputMode="decimal" value={raw.in ?? p.income ?? ''} placeholder="0" onInput={(e) => setP({ ...p, income: amount('in', (e.target as HTMLInputElement).value) })} />
        </label>
        <label>
          Gastos mensuales (COP)
          <input inputMode="decimal" value={raw.ex ?? p.expenses ?? ''} placeholder="0" onInput={(e) => setP({ ...p, expenses: amount('ex', (e.target as HTMLInputElement).value) })} />
        </label>
        <label>
          Máximo por acción (% del líquido)
          <input inputMode="decimal" value={shown('mp', p.maxPosition)} onInput={(e) => fraction('mp', (e.target as HTMLInputElement).value, (x) => setP({ ...p, maxPosition: x }))} />
        </label>
        <label>
          Máximo en finca raíz (% del patrimonio)
          <input inputMode="decimal" value={shown('re', p.maxRealEstate)} onInput={(e) => fraction('re', (e.target as HTMLInputElement).value, (x) => setP({ ...p, maxRealEstate: x }))} />
        </label>
        {owes && (
          <>
            <label>
              Fecha del pago del saldo del inmueble
              <input type="date" value={p.commitmentDue ?? ''} onInput={(e) => setP({ ...p, commitmentDue: (e.target as HTMLInputElement).value || undefined })} />
            </label>
            <label>
              Parte del saldo que pagas por fuera del portafolio (crédito aprobado, cesión…), COP
              <input inputMode="decimal" value={raw.fu ?? p.commitmentFunding ?? ''} placeholder="0" onInput={(e) => setP({ ...p, commitmentFunding: amount('fu', (e.target as HTMLInputElement).value) })} />
            </label>
            <label>
              Tasa del crédito (% efectivo anual)
              <input inputMode="decimal" value={shown('mr', p.mortgageRate)} onInput={(e) => fraction('mr', (e.target as HTMLInputElement).value, (x) => setP({ ...p, mortgageRate: (e.target as HTMLInputElement).value.trim() ? x : undefined }))} />
            </label>
            <label>
              Plazo del crédito (años)
              <input
                inputMode="numeric"
                value={raw.my ?? (p.mortgageYears === undefined ? '' : String(p.mortgageYears))}
                onInput={(e) => {
                  const x = (e.target as HTMLInputElement).value;
                  typed('my', x);
                  setP({ ...p, mortgageYears: x.trim() ? Number(amountIn(x) ?? NaN) : undefined });
                }}
              />
            </label>
            <label>
              El inmueble es…
              <select value={p.propertyPlan ?? ''} onChange={(e) => setP({ ...p, propertyPlan: ((e.target as HTMLSelectElement).value || undefined) as InvestorProfile['propertyPlan'] })}>
                <option value="">Sin decidir</option>
                <option value="vivir">Para vivir</option>
                <option value="arrendar">Para arrendar</option>
                <option value="vender">Para vender o ceder</option>
              </select>
            </label>
            {p.propertyPlan === 'arrendar' && (
              <>
                <label>
                  Arriendo mensual esperado (COP)
                  <input inputMode="decimal" value={raw.rt ?? p.rent ?? ''} placeholder="0" onInput={(e) => setP({ ...p, rent: amount('rt', (e.target as HTMLInputElement).value) })} />
                </label>
                <label>
                  Costos mensuales del arriendo: administración, predial, mantenimiento (COP)
                  <input inputMode="decimal" value={raw.rc ?? p.rentCosts ?? ''} placeholder="0" onInput={(e) => setP({ ...p, rentCosts: amount('rc', (e.target as HTMLInputElement).value) })} />
                </label>
              </>
            )}
          </>
        )}
      </div>
      <fieldset class="targets">
        <legend>Mezcla objetivo del portafolio líquido (%)</legend>
        {all.map((c) => (
          <label>
            {CLASS_LABEL(c)}
            <input inputMode="decimal" value={shown(`t:${c}`, p.targets[c] ?? 0)} onInput={(e) => fraction(`t:${c}`, (e.target as HTMLInputElement).value, (x) => setP({ ...p, targets: { ...p.targets, [c]: x } }))} />
          </label>
        ))}
        <span class={`small ${Math.abs(total - 1) > 0.001 ? 'bad' : 'muted'}`} role="status">
          Suman {pct(total, 1)}
        </span>
      </fieldset>
      {msg && <div class="notice err">{msg}</div>}
      <div class="actions">
        <button type="submit" class="primary">
          Guardar perfil
        </button>
        {initial && (
          <button type="button" onClick={onDone}>
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}

function MixCard({ a, v }: { a: Report; v: (x: Decimal) => string }) {
  const plan = a.plan;
  const parts = plan ? [...(plan.toReserve.gt(0) ? [`reserva del inmueble ${v(plan.toReserve)}`] : []), ...plan.split.map((s) => `${CLASS_LABEL(s.cls)} ${v(s.amount)}${a.avoid[s.cls]?.length ? ` (no a ${a.avoid[s.cls]!.join(', ')})` : ''}`)] : [];
  return (
    <section class="card" aria-labelledby="mezcla-h">
      <div class="card-head">
        <h2 id="mezcla-h">Tu mezcla líquida</h2>
        <span class="small muted">
          Sin finca raíz{a.reserve?.held.gt(0) ? ' ni la reserva para el inmueble' : ''} · {v(a.growth)}
        </span>
      </div>
      <div class="table-wrap">
        <table class="compact">
          <thead>
            <tr>
              <th>Clase</th>
              <th class="n hide-sm">Valor</th>
              <th class="n">Peso</th>
              <th class="n">Objetivo</th>
              <th class="n">Desvío</th>
              <th class="n hide-sm">Banda</th>
            </tr>
          </thead>
          <tbody>
            {a.mix.map((r) => (
              <tr>
                <td>{CLASS_LABEL(r.cls)}</td>
                <td class="n hide-sm">{v(r.value)}</td>
                <td class="n">{pct(r.weight, 1)}</td>
                <td class="n">{r.target === undefined ? '—' : pct(r.target, 0)}</td>
                <td class={`n ${r.outOfBand ? 'neg' : ''}`}>{r.drift === undefined ? '—' : `${r.drift > 0 ? '+' : ''}${pct(r.drift, 1)}`}</td>
                <td class="n hide-sm">{r.target === undefined ? '—' : `±${pct(band(r.target), 1)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {a.reserve && (
        <p class="small reserve-line">
          Reserva para el inmueble: {v(a.reserve.held)} apartados de {v(a.reserve.need)} que el portafolio debe poner al {date(a.reserve.due)}.
        </p>
      )}
      {plan ? (
        <div class="plan small">
          <strong>Este mes</strong>
          {plan.idleCash.gt(0) && <> (tu aporte y {v(plan.idleCash)} de efectivo por encima de su objetivo)</>}: {parts.join(' · ') || 'nada que mover'}.{' '}
          {plan.sellNeeded.gt(0) && `Con tus aportes no completas la reserva a tiempo: faltarían ${v(plan.sellNeeded)}. `}
          {a.reserve && !plan.onTime
            ? `Hasta el ${date(a.reserve.due)} tus aportes reúnen ${v(plan.gatheredByDue)} para la reserva; el resto debe venir del crédito, la cesión o una venta.`
            : plan.months === undefined
            ? 'Solo con aportes tardaría más de 10 años.'
            : plan.months <= 1
              ? 'Con eso quedas en tu mezcla.'
              : `Con el mismo aporte cada mes, unos ${plan.months} meses para ${a.reserve?.shortfall.gt(0) ? 'completar la reserva y ' : ''}volver a las bandas sin vender (a precios de hoy).`}
        </div>
      ) : (
        <p class="small muted">{a.profile ? 'Escribe tu aporte mensual en el perfil para ver a dónde mandarlo.' : 'Define tu perfil para comparar con una mezcla objetivo.'}</p>
      )}
    </section>
  );
}

function RecordCard({ r, v }: { r: ClassRecord; v: (x: Decimal) => string }) {
  const [all, setAll] = useState(false);
  const signed = (x: Decimal) => `${x.gt(0) ? '+' : ''}${v(x)}`;
  const rows = all ? r.holdings : r.holdings.filter((h) => h.open || (h.gap && h.gap.abs().gt(r.value.abs().times(0.01))));
  const w = r.windows.find((x) => x.id === 'all');
  return (
    <section class="card" aria-label={`${r.label} contra el índice`}>
      <div class="card-head">
        <h2>
          {r.label} contra el {r.bench.name}
        </h2>
        <span class={`small ${sign(r.gap.toNumber())}`}>{signed(r.gap)} frente al mismo dinero en el índice</span>
      </div>
      <p class="small muted">
        Cada fila compra y vende el índice en las mismas fechas y por el mismo monto que tú compraste, vendiste o cobraste dividendos de ese activo; la diferencia es lo que esa
        decisión sumó o restó frente a solo comprar el índice, y las filas suman el total de la clase. En las vendidas solo cuenta la diferencia. La TIR no se anualiza con menos de un
        año; «—» en la TIR del índice significa que tus retiros superan lo que habría dejado.
        {w && w.years < 1 && ` Desde ${date(w.since)} (menos de un año): KS-PME ${ratio(w.ksPme)}; la TIR no se anualiza.`}
        {w && w.years >= 1 && ` Desde ${date(w.since)}: tu TIR ${pct(w.xirr)}, la del índice con el mismo dinero ${pct(w.indexXirr)}; KS-PME ${ratio(w.ksPme)}: por cada $100 que tendrías en el índice, tienes $${Math.round(w.ksPme * 100)}.`}
        {r.bucket === 'fondos' && ' Si tus fondos son mixtos (acciones y renta fija), compararlos con un índice solo de acciones no es justo: tómalo como referencia.'}
      </p>
      {r.byStrategy.length > 1 && (
        <div class="chips strategy-chips">
          {r.byStrategy.map((g) => (
            <span class={`chip ${g.gap.gt(0) ? 'good' : g.gap.lt(0) ? 'bad' : ''}`}>
              {g.key} <strong>{signed(g.gap)}</strong>
            </span>
          ))}
        </div>
      )}
      <div class="table-wrap">
        <table class="compact">
          <thead>
            <tr>
              <th>Activo</th>
              <th>Estrategia</th>
              <th>Desde</th>
              <th class="n">Valor hoy</th>
              <th class="n">En el índice</th>
              <th class="n">Diferencia</th>
              <th class="n">Tu TIR</th>
              <th class="n">TIR índice</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr>
                <td>
                  {h.name}
                  {!h.open && <span class="badge">vendida</span>}
                </td>
                <td>{h.strategy}</td>
                <td>{date(h.since)}</td>
                <td class="n">{h.value ? v(h.value) : 'sin datos'}</td>
                <td class="n">{h.indexValue && h.open ? v(h.indexValue) : '—'}</td>
                <td class={`n ${sign(h.gap?.toNumber())}`} title={h.missing}>
                  {h.gap ? signed(h.gap) : 'sin datos'}
                </td>
                <td class="n">{h.young ? '< 1 año' : pct(h.xirr)}</td>
                <td class="n">{h.young ? '< 1 año' : pct(h.indexXirr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length < r.holdings.length && (
        <button type="button" class="link small" onClick={() => setAll(true)}>
          Ver también las {r.holdings.length - rows.length} vendidas con diferencia pequeña
        </button>
      )}
      {r.missing.length > 0 && <p class="small muted">Sin comparar (falta el índice en alguna fecha): {r.missing.join(', ')}.</p>}
    </section>
  );
}

function RiskCard({ a }: { a: Report }) {
  const r = a.risk;
  if (!r.crisisParts.length) return null;
  return (
    <section class="card" aria-labelledby="riesgo-h">
      <div class="card-head">
        <h2 id="riesgo-h">Cuánto puede caer</h2>
        {a.profile && <span class="small muted">Aguantas {pct(a.profile.maxDrawdown, 0)} en el portafolio líquido</span>}
      </div>
      <div class="tiles">
        {r.historical && (
          <div class="tile">
            <div>
              <div class="label">Tu peor caída, últimos {RISK_YEARS} años</div>
              <div class="value neg">{pct(r.historical.depth, 1)}</div>
              <div class="sub">
                Portafolio líquido, {date(r.historical.peak)} → {date(r.historical.trough)}, en pesos, a fin de mes
              </div>
            </div>
          </div>
        )}
        <div class="tile">
          <div>
            <div class="label">{CRISIS.label}: portafolio líquido</div>
            <div class="value neg">{pct(r.crisisLiquid, 1)}</div>
            <div class="sub">Con tu mezcla de hoy</div>
          </div>
        </div>
        {r.crisisNetWorth !== undefined && a.realEstate && (
          <div class="tile">
            <div>
              <div class="label">{CRISIS.label}: patrimonio</div>
              <div class="value neg">{pct(r.crisisNetWorth, 1)}</div>
              <div class="sub">Con el inmueble y lo que aún debes: la deuda no baja con el precio</div>
            </div>
          </div>
        )}
      </div>
      <table class="compact small">
        <thead>
          <tr>
            <th>Clase</th>
            <th class="n">Peso en el líquido</th>
            <th class="n">Caída supuesta</th>
          </tr>
        </thead>
        <tbody>
          {r.crisisParts.map((s) => (
            <tr>
              <td>{CLASS_LABEL(s.cls)}</td>
              <td class="n">{pct(s.weight, 1)}</td>
              <td class="n neg">{pct(s.shock, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.indexFalls.length > 0 && (
        <p class="small muted">
          Peores caídas de tus índices en los precios guardados (a fin de mes, en {a.home}):{' '}
          {r.indexFalls.map((x) => `${x.bench} ${pct(x.depth, 0)} (${date(x.peak)} → ${date(x.trough)})`).join(' · ')}.
        </p>
      )}
      <p class="small muted">{CRISIS.note} Es un escenario para medir el tamaño del golpe, no un pronóstico.</p>
    </section>
  );
}

function Method() {
  return (
    <details class="card small method">
      <summary>Cómo se calcula y sus límites</summary>
      <ul>
        <li>
          <strong>En pesos:</strong> el riesgo, la reserva y los veredictos contra los índices se calculan en pesos, la moneda en que gastas; cambiar la vista a dólares solo convierte
          las cifras a la tasa del corte.
        </li>
        <li>
          <strong>Contra el índice:</strong> cada compra, venta y dividendo de un activo se replica en el índice de su clase el mismo día y por el mismo monto (equivalente de mercado
          público, PME). La diferencia de valor hoy es exacta y las filas suman el total de la clase. El KS-PME (Kaplan–Schoar) dice cuánto tienes por cada $100 que tendrías en el
          índice. Una clase se juzga solo con {MIN_YEARS} años o más de historia: por debajo de {ratio(LAG_PME)} desde el inicio y de 1 en los últimos 3 años, «rinde menos»; por
          encima de {ratio(LEAD_PME)} y de 1, «supera».
        </li>
        <li>
          <strong>Primero los pagos:</strong> si debes el saldo de un inmueble, lo que el portafolio tenga que poner se aparta en pesos de bajo riesgo antes de invertir en la mezcla;
          el efectivo en pesos y la renta fija cuentan como ya apartados.
        </li>
        <li>
          <strong>Prioridad:</strong> alta cuando el dinero en juego es al menos el 1 % de tu patrimonio y la clase pesa 5 % o más; lo que ya no cambia mucho baja a media o baja.
        </li>
        <li>
          <strong>Mezcla y bandas:</strong> regla 5/25 (5 puntos en clases de 20 % o más; un cuarto del objetivo en las menores). El plan manda el dinero nuevo y el efectivo por
          encima de su objetivo a las clases más por debajo, sin vender; supone precios constantes.
        </li>
        <li>
          <strong>Límites por defecto</strong> mientras no definas tu perfil: {pct(DEFAULT_POLICY.maxPosition, 0)} por acción, {pct(DEFAULT_POLICY.maxRealEstate, 0)} en finca raíz y{' '}
          {pct(DEFAULT_POLICY.cash, 0)} de efectivo. Los fondos indexados, los fondos y la cripto no cuentan como una acción.
        </li>
        <li>
          <strong>Finca raíz:</strong> se mide neta de lo que aún debes; el ritmo de pago es el promedio de los últimos 6 meses. Si su valor es precio de lista, es un estimado.
        </li>
        <li>
          <strong>Lo que no hace:</strong> no pronostica rentabilidades, no conoce tus ingresos, gastos, otras deudas ni tu situación tributaria, y no sugiere acciones nuevas: los
          únicos vehículos que menciona son los índices con los que ya te comparas y los fondos indexados que ya tienes. Las notas tributarias son generales: confírmalas con tu
          contador.
        </li>
      </ul>
    </details>
  );
}
