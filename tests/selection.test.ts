import { describe, expect, it } from 'vitest';
import { parseSelection, pick } from '../src/app/selection.ts';

const all = ['acciones_usd', 'acciones_cop', 'cripto', 'inmobiliario', 'cash'];

describe('portfolio selection on Resumen', () => {
  it('a click shows only that portfolio; clicking it again shows everything', () => {
    expect(pick(null, 'cripto', all, false)).toEqual(['cripto']);
    expect(pick(['cripto'], 'cripto', all, false)).toBeNull();
    expect(pick(['cripto', 'cash'], 'cripto', all, false)).toEqual(['cripto']);
  });

  it('Ctrl-click adds or removes, starting from everything', () => {
    const noRealEstate = pick(null, 'inmobiliario', all, true);
    expect(noRealEstate).toEqual(['acciones_usd', 'acciones_cop', 'cripto', 'cash']);
    expect(pick(noRealEstate, 'cripto', all, true)).toEqual(['acciones_usd', 'acciones_cop', 'cash']);
    expect(pick(['cripto'], 'acciones_usd', all, true)).toEqual(['acciones_usd', 'cripto']);
    expect(pick(noRealEstate, 'inmobiliario', all, true)).toBeNull(); // back to all
    expect(pick(['cripto'], 'cripto', all, true)).toBeNull(); // nothing left means everything
  });

  it('a saved selection drops portfolios that no longer exist', () => {
    expect(parseSelection('cripto,gone', all)).toEqual(['cripto']);
    expect(parseSelection('', all)).toBeNull();
    expect(parseSelection('gone', all)).toBeNull();
  });
});
