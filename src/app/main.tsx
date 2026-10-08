import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles.css';
import { ready, useDataset, usePref } from './store.ts';
import { Summary } from './views/Summary.tsx';
import { Investments } from './views/Investments.tsx';
import { Transactions } from './views/Transactions.tsx';
import { MonthlyClose } from './views/MonthlyClose.tsx';
import { Tracking } from './views/Tracking.tsx';
import { Indicators } from './views/Indicators.tsx';
import { Dividends } from './views/Dividends.tsx';
import { Advice } from './views/Advice.tsx';
import { Compare } from './views/Compare.tsx';
import { DataView } from './views/Data.tsx';
import { initSync, syncConfigured, useSync } from './sync.ts';
import { autoSec } from './views/SecCard.tsx';
import { STATUS_LABEL } from './views/SyncCard.tsx';

// Most visited first; the ones for entering data last.
const ROUTES = [
  { id: 'resumen', label: 'Resumen', view: Summary },
  { id: 'inversiones', label: 'Inversiones', view: Investments },
  { id: 'mes-a-mes', label: 'Mes a mes', view: Tracking },
  { id: 'dividendos', label: 'Dividendos', view: Dividends },
  { id: 'mercado', label: 'Contra el mercado', view: Compare },
  { id: 'tesis', label: 'Tesis', view: Indicators },
  { id: 'plan', label: 'Mi plan', view: Advice },
  { id: 'cierre', label: 'Cierre del mes', view: MonthlyClose },
  { id: 'movimientos', label: 'Movimientos', view: Transactions },
  { id: 'datos', label: 'Datos', view: DataView },
] as const;

/** Earlier names of the tabs, so saved links and bookmarks still land on the same screen. */
const OLD_ROUTES: Record<string, string> = {
  activos: 'inversiones?ver=posiciones',
  precios: 'inversiones?ver=precios',
  seguimiento: 'mes-a-mes',
  comparacion: 'mercado',
  indicadores: 'tesis',
  orientacion: 'plan',
};

// Apply a saved theme before the first paint, so a dark choice does not flash light.
try {
  const saved = localStorage.getItem('pref:theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  /* private window: follow the system */
}

/** Light/dark switch. Until the user flips it, the page follows the system setting. */
function ThemeSwitch() {
  const [theme, setTheme] = usePref<'' | 'light' | 'dark'>('theme', '');
  const [system, setSystem] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystem(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  const dark = theme ? theme === 'dark' : system;
  return (
    <button type="button" class="theme-switch" role="switch" aria-checked={dark} aria-label="Modo oscuro" title={dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'} onClick={() => setTheme(dark ? 'light' : 'dark')}>
      <span class="knob" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2.2} stroke-linecap="round" stroke-linejoin="round">
          {dark ? <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>}
        </svg>
      </span>
    </button>
  );
}

/** Header dot for cloud sync, linking to its card in Datos. Only on builds with sync configured. */
function SyncBadge() {
  const s = useSync();
  return (
    <a href="#/datos" class="sync-badge" title={s.message ?? STATUS_LABEL[s.status]} aria-label={`Sincronización: ${STATUS_LABEL[s.status]}`}>
      <span class={`sync-dot ${s.status}`} aria-hidden="true" />
      <span class="sync-label">{STATUS_LABEL[s.status]}</span>
    </a>
  );
}

function useRoute(): string {
  const get = () => {
    const [id = '', query] = location.hash.replace(/^#\/?/, '').split('?');
    const to = OLD_ROUTES[id];
    if (!to) return id;
    const keep = query ? (to.includes('?') ? '&' : '?') + query : '';
    history.replaceState(null, '', `#/${to}${keep}`);
    return to.split('?')[0]!;
  };
  const [r, setR] = useState(get);
  useEffect(() => {
    const on = () => setR(get());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return r;
}

function App() {
  const { data, loaded, storageError } = useDataset();
  const route = useRoute();
  if (!loaded) return <main class="muted">Cargando…</main>;
  const empty = data.ledger.length === 0;
  const current = ROUTES.find((r) => r.id === route) ?? (empty ? ROUTES.find((r) => r.id === 'datos')! : ROUTES[0]);
  const View = current.view;
  return (
    <>
      <header class="top">
        <div class="bar">
          <div class="brand">
            <h1>Mis inversiones</h1>
          </div>
          <nav class="tabs" aria-label="Secciones">
            {ROUTES.map((r) => (
              <a href={`#/${r.id}`} aria-current={r.id === current.id ? 'page' : undefined}>
                {r.label}
              </a>
            ))}
          </nav>
          {syncConfigured && <SyncBadge />}
          <ThemeSwitch />
        </div>
      </header>
      <main>
        {storageError && <div class="notice err">{storageError}</div>}
        {empty && current.id !== 'datos' ? (
          <div class="card">
            <p>Todavía no hay movimientos. Ve a <a href="#/datos">Datos</a> para importar tu respaldo o cargar el portafolio de demostración.</p>
          </div>
        ) : (
          <View />
        )}
      </main>
    </>
  );
}

render(<App />, document.getElementById('app')!);
void initSync();
void ready.then(autoSec);
