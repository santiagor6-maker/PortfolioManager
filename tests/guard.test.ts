import { describe, expect, it } from 'vitest';
import { bypassesHooks, changedCode, contentProblems, pathProblem } from '../scripts/guard.ts';

describe('pre-commit: personal data stays out of the repo', () => {
  it('blocks spreadsheets, statements, real CSVs, backups, env files and screenshots', () => {
    for (const p of [
      'Fondos de Inversion.xlsx', 'data/extracto-etoro.pdf', 'movimientos-2026-09-27.csv', 'mis-inversiones-respaldo-v5.json',
      'inversiones-respaldo-2026-09-27.json', '.env', 'app/.env.local', 'shots/resumen.png', 'notas/bitácora.txt', 'foo/bar.json',
    ]) expect(pathProblem(p), p).toBeDefined();
  });

  it('lets code, docs, configuration and synthetic samples through', () => {
    for (const p of [
      'src/app/checks.ts', 'samples/ledger.csv', 'tests/fixtures/rows.csv', 'samples/book.json', 'tests/fixtures/x.json', 'package.json', 'package-lock.json',
      'tsconfig.json', '.claude/settings.json', '.claude/skills/import-statement/SKILL.md', '.env.example', 'docs/demo.png', 'README.md',
    ]) expect(pathProblem(p), p).toBeUndefined();
  });

  it('finds a backup of the app inside any file outside samples/ and tests/', () => {
    const backup = JSON.stringify({ format: 'investment-tracker', version: 1, ledger: [] }, null, 1);
    expect(contentProblems('notes/whatever.md', backup, [])).toEqual(['contiene un respaldo de la app (datos personales)']);
    expect(contentProblems('tests/fixtures/x.json', backup, [])).toEqual([]);
    expect(contentProblems('src/data/json.ts', "format: 'investment-tracker'", [])).toEqual([]);
  });

  it('finds secrets on added lines', () => {
    const lines = [
      `const k = "${'sk-' + 'ant-'}${'a'.repeat(30)}";`,
      `aws = ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`,
      `SUPABASE_KEY: ${'eyJ'}${'h'.repeat(20)}.${'eyJ'}${'p'.repeat(20)}.${'s'.repeat(20)}`,
      `apiKey = "${'x'.repeat(24)}"`,
      'const priceSource = "desconocida"; // not a secret',
    ];
    expect(contentProblems('src/x.ts', '', lines).map((m) => m.split(':')[0])).toEqual([
      'clave de API de Anthropic', 'clave de acceso de AWS', 'JWT (p. ej. una clave de Supabase)', 'posible clave o contraseña escrita en el código',
    ]);
  });
});

describe('Claude Code hooks', () => {
  it('denies commands that skip or disable the pre-commit hook', () => {
    for (const c of [
      'git commit --no-verify -m "x"', 'git commit -nm "x"', 'git add . && git commit -n -m x', 'git push --no-verify',
      'git -c core.hooksPath=/dev/null commit -m x', 'git config core.hooksPath /tmp/none', 'git config --unset core.hooksPath',
      'git commit --no-veri -m x', 'git -c core.hookspath=/dev/null commit -m x',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    ]) expect(bypassesHooks(c), c).toBeDefined();
  });

  it('allows ordinary git commands', () => {
    for (const c of [
      'git commit -m "Add -n flag handling"', 'git commit -am "fix"', 'git push -u origin main', 'git log -n 5 --grep commit',
      'git config core.hooksPath .githooks', 'git config core.hooksPath', 'npm test', 'git status',
    ]) expect(bypassesHooks(c), c).toBeUndefined();
  });

  it('the Stop hook runs the checks only when code changed (renames included)', () => {
    expect(changedCode(' M README.md\0?? notes.txt\0')).toEqual([]);
    expect(changedCode(' M src/app/checks.ts\0?? tests/new.test.ts\0')).toEqual(['src/app/checks.ts', 'tests/new.test.ts']);
    expect(changedCode('R  docs/a.md\0src/old.ts\0')).toEqual(['src/old.ts']);
  });
});
