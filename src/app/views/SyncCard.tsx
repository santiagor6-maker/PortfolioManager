import { useState } from 'preact/hooks';
import { downloadReplaced, keepThisDevice, signIn, signOut, syncNow, useCloudCopy, useSync } from '../sync.ts';
import type { SyncStatus } from '../sync.ts';

const MIN_PASSWORD = 10;

export const STATUS_LABEL: Record<SyncStatus, string> = {
  off: 'Solo en este navegador',
  starting: 'Conectando…',
  'signed-out': 'Sin sincronizar',
  'needs-password': 'Falta la contraseña',
  synced: 'Sincronizado',
  pending: 'Cambios por subir',
  syncing: 'Sincronizando…',
  offline: 'Sin conexión',
  conflict: 'Conflicto',
  error: 'Error de sincronización',
};

function when(iso?: string): string {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Datos → Sincronización: sign in (or create the account) with email and password, see the state. */
export function SyncCard() {
  const s = useSync();
  const [email, setEmail] = useState(s.email ?? '');
  const [create, setCreate] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [ack, setAck] = useState(false);
  const [working, setWorking] = useState(false);
  const act = (f: () => Promise<void>) => async (e?: Event) => {
    e?.preventDefault();
    setWorking(true);
    try {
      await f();
    } finally {
      setWorking(false);
      setPass('');
      setPass2('');
    }
  };

  return (
    <div class="card sync-card">
      <h2>Sincronización</h2>
      <p class="small muted">
        Guarda una copia <strong>cifrada</strong> en la nube para ver tus datos en todos tus dispositivos. Se cifra en este navegador con tu contraseña: ni el
        servicio ni nadie más puede leerla.
      </p>
      {s.message && <div class={`notice ${s.status === 'offline' ? 'warn' : 'err'}`} role="alert">{s.message}</div>}

      {s.status === 'starting' && <p class="small muted">Conectando con la nube…</p>}

      {s.status === 'signed-out' && (
        <form onSubmit={act(() => signIn(email, pass, create))}>
          <div class="form-grid">
            <label class="field">
              Correo
              <input type="email" required autocomplete="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              Contraseña
              <input
                type="password"
                required
                autocomplete={`${create ? 'new' : 'current'}-password`}
                value={pass}
                onInput={(e) => setPass((e.target as HTMLInputElement).value)}
              />
            </label>
            {create && (
              <label class="field">
                Repite la contraseña
                <input type="password" autocomplete="new-password" value={pass2} onInput={(e) => setPass2((e.target as HTMLInputElement).value)} />
              </label>
            )}
          </div>
          {create && (
            <>
              <p class="small muted">
                Mínimo {MIN_PASSWORD} caracteres. La misma contraseña cifra tus datos: ni Supabase ni nadie más puede leerlos, y por eso no se puede recuperar.
              </p>
              <label class="check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck((e.target as HTMLInputElement).checked)} /> Entiendo que si olvido la contraseña no se puede recuperar la
                copia en la nube (mis respaldos .json siguen sirviendo).
              </label>
            </>
          )}
          <div class="actions">
            <button class="primary" disabled={working || !email || !pass || (create && (!ack || pass.length < MIN_PASSWORD || pass !== pass2))}>
              {create ? 'Crear cuenta y sincronizar' : 'Entrar'}
            </button>
            <button type="button" class="link" onClick={() => setCreate(!create)}>
              {create ? 'Ya tengo cuenta' : 'Crear cuenta (primera vez)'}
            </button>
            {create && pass2 && pass !== pass2 && <span class="small bad">Las contraseñas no coinciden.</span>}
          </div>
        </form>
      )}

      {s.status === 'needs-password' && (
        <form class="actions" onSubmit={act(() => signIn(s.email ?? '', pass))}>
          <label class="field">
            Contraseña de {s.email}
            <input type="password" autocomplete="current-password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} />
          </label>
          <button class="primary" disabled={working || !pass}>Abrir mis datos</button>
          <button type="button" class="link" disabled={working} onClick={act(signOut)}>Usar otro correo</button>
        </form>
      )}

      {s.status === 'conflict' && s.remote?.version === 0 && (
        <div class="notice warn">
          <p>
            <strong>La copia en la nube ya no existe.</strong> Sube la de este dispositivo para volver a tenerla sincronizada.
          </p>
          <div class="actions">
            <button class="primary" disabled={working} onClick={act(keepThisDevice)}>Subir la de este dispositivo</button>
          </div>
        </div>
      )}

      {s.status === 'conflict' && s.remote?.version !== 0 && (
        <div class="notice warn">
          <p>
            <strong>Hay cambios distintos en este dispositivo y en la nube</strong>
            {s.remote?.updatedAt && ` (la nube se guardó el ${when(s.remote.updatedAt)}${s.remote.device ? ` desde un ${s.remote.device}` : ''})`}. Elige cuál conservar: la otra
            versión se descarga como respaldo y queda guardada en este dispositivo antes de reemplazarse.
          </p>
          <div class="actions">
            <button class="primary" disabled={working} onClick={act(keepThisDevice)}>Conservar este dispositivo</button>
            <button disabled={working} onClick={act(useCloudCopy)}>Usar la copia de la nube</button>
          </div>
        </div>
      )}

      {['synced', 'pending', 'syncing', 'offline', 'error', 'conflict'].includes(s.status) && (
        <div class="actions sync-state">
          <span class={`sync-dot ${s.status}`} aria-hidden="true" />
          <span>
            <strong>{STATUS_LABEL[s.status]}</strong> · {s.email} · última sincronización: {when(s.lastSync)}
          </span>
          <button disabled={working || s.status === 'conflict'} onClick={act(syncNow)}>Sincronizar ahora</button>
          <button class="link" disabled={working} onClick={act(signOut)}>Cerrar sesión en este dispositivo</button>
        </div>
      )}
      {s.replacedAt && s.status !== 'off' && (
        <p class="small muted" style="margin-top:8px">
          La última versión reemplazada ({when(s.replacedAt)}) sigue guardada aquí.{' '}
          <button class="link" onClick={() => void downloadReplaced()}>Descargarla</button>
        </p>
      )}
    </div>
  );
}
