/**
 * Repository guards, run by git and by Claude Code (.claude/settings.json):
 *
 *   node scripts/guard.ts pre-commit   git pre-commit hook (.githooks/pre-commit, enabled by `npm install`)
 *   node scripts/guard.ts bash         Claude Code PreToolUse hook: no bypassing the pre-commit hook
 *   node scripts/guard.ts stop         Claude Code Stop hook: typecheck and unit tests before a turn ends with code changes
 *
 * The pre-commit hook keeps personal financial data and secrets out of the repo (CLAUDE.md, "Data and privacy") and
 * refuses code that does not typecheck or pass the unit tests. It checks the working tree, not a partial staging.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Problem {
  path: string;
  message: string;
}

/** Paths whose change calls for the typecheck and the unit tests. */
export const CODE = /^(src|tests|scripts|samples|e2e)\/|^(package(-lock)?\.json|tsconfig\.json|vite\.config\.ts|playwright\.config\.ts)$/;

const SHEETS = /\.(xlsx|xlsm|xls|ods|numbers|pdf|ofx|qfx)$/i;
const IMAGES = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;
const DATA_NAME = /(respaldo|backup|extracto|statement|mis-inversiones|bitacora|bitácora)[^/]*\.(json|csv|txt|html?|xml|zip)$/i;
/** JSON files that are configuration or synthetic fixtures. Anything else might be a backup. */
const JSON_OK = /^(package(-lock)?\.json|tsconfig(\.[\w-]+)?\.json|\.claude\/settings\.json|samples\/.+|tests\/.+)$/;
/** Where synthetic data lives. */
const SYNTHETIC = /^(samples|tests)\//;
const MAX_BYTES = 2_000_000;

/** A problem with the path alone: spreadsheets, statements, exports, env files, screenshots. */
export function pathProblem(path: string): string | undefined {
  const name = path.split('/').pop()!;
  if (SHEETS.test(path)) return 'hoja de cálculo o extracto: los archivos con datos personales no van al repositorio';
  if (/\.csv$/i.test(path) && !/^samples\//.test(path)) return 'CSV fuera de samples/: los datos reales no van al repositorio (los sintéticos van en samples/)';
  if (/^\.env/.test(name) && name !== '.env.example') return 'archivo .env: las claves van en variables de entorno, no en el repositorio';
  if (IMAGES.test(path) && !/^docs\//.test(path)) return 'imagen fuera de docs/: las capturas pueden mostrar cifras reales (si es sintética, muévela a docs/)';
  if (DATA_NAME.test(path)) return 'el nombre parece de un respaldo o extracto personal';
  if (/\.json$/i.test(path) && !JSON_OK.test(path)) return 'JSON fuera de samples/ o tests/: puede ser un respaldo (si es configuración, agrégalo a JSON_OK en scripts/guard.ts)';
  return undefined;
}

// Kept as separate pieces so this file does not trip its own scan.
const SECRETS: [RegExp, string][] = [
  [new RegExp('sk-' + 'ant-[A-Za-z0-9_-]{20,}'), 'clave de API de Anthropic'],
  [new RegExp('\\b(AKIA|ASIA)' + '[0-9A-Z]{16}\\b'), 'clave de acceso de AWS'],
  [new RegExp('\\bgh[pousr]_' + '[A-Za-z0-9]{36,}\\b'), 'token de GitHub'],
  [new RegExp('\\bxox[abprs]-' + '[A-Za-z0-9-]{10,}'), 'token de Slack'],
  [new RegExp('-----BEGIN (RSA |EC |OPENSSH |DSA )?' + 'PRIVATE KEY-----'), 'llave privada'],
  [new RegExp('\\beyJ[A-Za-z0-9_-]{10,}\\.' + 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}'), 'JWT (p. ej. una clave de Supabase)'],
  [/\b(api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i, 'posible clave o contraseña escrita en el código'],
];
const BACKUP = new RegExp('"format"\\s*:\\s*"' + 'investment-tracker"');

/** Problems in a staged file's content: a backup of the app's data, or a secret on an added line. */
export function contentProblems(path: string, text: string, added: readonly string[]): string[] {
  const out: string[] = [];
  if (!SYNTHETIC.test(path) && BACKUP.test(text)) out.push('contiene un respaldo de la app (datos personales)');
  for (const line of added) {
    for (const [re, what] of SECRETS) if (re.test(line)) out.push(`${what}: ${line.trim().slice(0, 60)}…`);
  }
  return out;
}

const git = (...args: string[]) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** Lines added per file in the index (unified diff with no context). */
function addedLines(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file = '';
  for (const line of git('diff', '--cached', '--no-color', '--no-ext-diff', '-U0', '--diff-filter=ACMR').split('\n')) {
    if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : '';
    else if (line.startsWith('+') && file) out.set(file, [...(out.get(file) ?? []), line.slice(1)]);
  }
  return out;
}

export function stagedProblems(): { problems: Problem[]; paths: string[] } {
  const paths = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean);
  const added = addedLines();
  const problems: Problem[] = [];
  for (const path of paths) {
    const p = pathProblem(path);
    if (p) {
      problems.push({ path, message: p });
      continue;
    }
    const size = Number(git('cat-file', '-s', `:${path}`).trim());
    if (size > MAX_BYTES) {
      problems.push({ path, message: `pesa ${(size / 1e6).toFixed(1)} MB: ¿un respaldo o un build?` });
      continue;
    }
    const text = git('show', `:${path}`);
    if (text.includes('\0')) continue; // binary
    for (const message of contentProblems(path, text, added.get(path) ?? [])) problems.push({ path, message });
  }
  return { problems, paths };
}

/** Runs the typecheck and the unit tests; returns the failing output, or undefined when both pass. */
function verify(): string | undefined {
  for (const script of ['typecheck', 'test']) {
    const r = spawnSync('npm', ['run', '--silent', script], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status !== 0) return `npm run ${script} falló:\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n')}`;
  }
  return undefined;
}

function preCommit(): number {
  const { problems, paths } = stagedProblems();
  if (problems.length) {
    console.error('Commit bloqueado: el repositorio no guarda datos personales ni claves (CLAUDE.md).');
    for (const p of problems) console.error(`  ✗ ${p.path}: ${p.message}`);
    console.error('Saca esos archivos del commit (git restore --staged <archivo>) y guárdalos fuera del repositorio; una clave va en una variable de entorno, no en el código.');
    return 1;
  }
  if (paths.some((p) => CODE.test(p))) {
    const failed = verify();
    if (failed) {
      console.error(`Commit bloqueado: ${failed}`);
      return 1;
    }
  }
  return 0;
}

/** Git commands that would skip or disable the pre-commit hook. */
export function bypassesHooks(command: string): string | undefined {
  // Look at each simple command of a compound one (a && b; c | d).
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const c = part.trim();
    if (!/(^|\s)git(\s|$)/.test(c)) continue;
    if (/--no-verify\b/.test(c)) return 'usa --no-verify';
    const bare = c.replace(/(["']).*?\1/g, '');
    if (/\bgit(\s+-[cC]\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+commit\b/.test(bare) && /\s-[a-zA-Z]*n[a-zA-Z]*(\s|$)/.test(bare)) return 'usa commit -n (se salta el hook)';
    if (/-c\s+core\.hooksPath\s*=/.test(c)) return 'cambia core.hooksPath en la línea de comandos';
    const cfg = c.match(/\bconfig\b.*\bcore\.hooksPath\b\s*(\S*)/);
    if (cfg && (/--unset/.test(c) || (cfg[1] !== undefined && cfg[1] !== '' && cfg[1].replace(/["']/g, '') !== '.githooks'))) {
      return 'cambia core.hooksPath (debe ser .githooks)';
    }
  }
  return undefined;
}

function readStdin(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function bashHook(): number {
  const input = readStdin() as { tool_input?: { command?: string } };
  const why = bypassesHooks(input.tool_input?.command ?? '');
  if (why) {
    const reason = `Bloqueado: el comando ${why}. El hook de pre-commit protege tus datos personales y exige pruebas en verde; corrige lo que reporta en lugar de saltarlo.`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  }
  return 0;
}

/** Changed code paths in the working tree (staged, unstaged or untracked). */
export function changedCode(porcelain: string): string[] {
  const entries = porcelain.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    // A rename or copy is followed by its original path.
    if (/^[RC]|^.[RC]/.test(e)) paths.push(entries[++i] ?? '');
  }
  return paths.filter((p) => CODE.test(p));
}

function stopHook(): number {
  const input = readStdin() as { stop_hook_active?: boolean };
  // Already continuing because of this hook: let the turn end rather than loop.
  if (input.stop_hook_active) return 0;
  let changed: string[];
  try {
    changed = changedCode(git('status', '--porcelain', '-z', '--untracked-files=all'));
  } catch {
    return 0;
  }
  if (!changed.length) return 0;
  const failed = verify();
  if (failed) console.log(JSON.stringify({ decision: 'block', reason: `Hay cambios de código sin verificar y ${failed}\nCorrígelo antes de terminar.` }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  const run = { 'pre-commit': preCommit, bash: bashHook, stop: stopHook }[mode ?? ''];
  if (!run) {
    console.error('Uso: node scripts/guard.ts <pre-commit|bash|stop>');
    process.exit(2);
  }
  try {
    process.chdir(git('rev-parse', '--show-toplevel').trim());
  } catch {
    /* not a git checkout: the Claude Code hooks have nothing to check */
    if (mode !== 'pre-commit') process.exit(0);
  }
  process.exit(run());
}
