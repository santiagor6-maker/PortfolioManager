import { describe, expect, it } from 'vitest';
import { dec } from '../src/domain/money.ts';
import { editablePrice, field, impliedPrice, parseNum, rateCheck, rateQuote, storedRate, tradeTotal } from '../src/app/trade.ts';
import { FxTable } from '../src/domain/fx.ts';

describe('a buy or sale entered as units × price', () => {
  it('a buy adds the fee to what leaves the account; a sale takes it from what comes in', () => {
    // 10 × 25,40 = 254,00; + 1,99 = 255,99 out; − 1,99 = 252,01 in.
    expect(tradeTotal('BUY', dec(10), dec('25.40'), dec('1.99')).toString()).toBe('255.99');
    expect(tradeTotal('SELL', dec(10), dec('25.40'), dec('1.99')).toString()).toBe('252.01');
    expect(tradeTotal('BUY', dec(2), dec('125.25'), undefined).toString()).toBe('250.5');
  });

  it('rounds to the cent, half up', () => {
    // 3 × 10,125 = 30,375 → 30,38.
    expect(tradeTotal('BUY', dec(3), dec('10.125'), undefined).toString()).toBe('30.38');
  });

  it('a sale whose fee exceeds the gross comes out negative, for the form to reject', () => {
    // 1 × 0,50 − 1,00 = −0,50: never stored as a +0,50 sale.
    expect(tradeTotal('SELL', dec(1), dec('0.5'), dec(1)).toString()).toBe('-0.5');
  });

  it('the price a stored total implies takes the fee out of a buy and adds it back to a sale', () => {
    // Buy −255,99 with fee 1,99 → 254 / 10 = 25,4; sale 252,01 + 1,99 → 254 / 10 = 25,4.
    expect(impliedPrice('BUY', dec('-255.99'), dec(10), dec('1.99')).toString()).toBe('25.4');
    expect(impliedPrice('SELL', dec('252.01'), dec(10), dec('1.99')).toString()).toBe('25.4');
  });
});

describe('editing a stored buy or sale never changes its amount', () => {
  it('opens as units × price when that gives back the stored total', () => {
    expect(editablePrice({ type: 'BUY', amount: dec('-255.99'), qty: dec(10), fee: dec('1.99') })!.toString()).toBe('25.4');
  });

  it('keeps the typed total when no price to 6 decimals gives it back', () => {
    // 100 / 3 = 33,333333 → 3 × 33,333333 = 99,999999 → 100,00 ✓; but 0,01 over 7 units can't be rebuilt.
    expect(editablePrice({ type: 'BUY', amount: dec('-100'), qty: dec(3) })?.toString()).toBe('33.333333');
    expect(editablePrice({ type: 'SELL', amount: dec('0.01'), qty: dec(7000000) })).toBeUndefined();
    // No units, or not a trade: always the total.
    expect(editablePrice({ type: 'BUY', amount: dec('-500') })).toBeUndefined();
    expect(editablePrice({ type: 'DIVIDEND', amount: dec('5'), qty: dec(1) })).toBeUndefined();
  });
});

describe('typed numbers', () => {
  it('in pesos a dot before three digits is a thousands separator', () => {
    expect(parseNum('2.345', 'COP')!.toString()).toBe('2345');
    expect(parseNum('234.500', 'COP')!.toString()).toBe('234500');
    expect(parseNum('1.234.567,89', 'COP')!.toString()).toBe('1234567.89');
  });

  it('elsewhere a lone dot stays a decimal point', () => {
    expect(parseNum('2.345', 'USD')!.toString()).toBe('2.345');
    expect(parseNum('125,25', 'USD')!.toString()).toBe('125.25');
    expect(parseNum('1,234.5', 'USD')!.toString()).toBe('1234.5');
    expect(parseNum('', 'USD')).toBeUndefined();
    expect(parseNum('abc', 'USD')).toBeUndefined();
  });
});

describe('a stored figure written back into the form reads back the same', () => {
  it('in pesos and dollars, with three decimals, tiny or large', () => {
    for (const ccy of ['COP', 'USD'])
      for (const x of ['12.345', '125.125', '0.123', '0.00000012', '1234500', '8000']) expect(parseNum(field(dec(x)), ccy)!.eq(dec(x))).toBe(true);
    // A peso quantity of 12,345 is never read back as 12.345 units.
    expect(field(dec('12.345'))).toBe('12,345');
  });

  it('a group of thousands never starts with zero', () => {
    expect(parseNum('0.123', 'COP')!.toString()).toBe('0.123');
  });
});

describe('a stock quoted in another currency than the account', () => {
  it('the total is units × price in its currency × the broker rate, ± the fee in the account currency', () => {
    // Sale of 10 at 12,50 EUR at 1,0850 USD per EUR: 135,625 → − 1,00 fee = 134,625 → 134,63 USD (half up).
    expect(tradeTotal('SELL', dec(10), dec('12.5'), dec(1), dec('1.085')).toString()).toBe('134.63');
    // Buy of 3 at 40 CAD at 0,7300 USD per CAD + 0,35 = 87,95 USD.
    expect(tradeTotal('BUY', dec(3), dec(40), dec('0.35'), dec('0.73')).toString()).toBe('87.95');
  });

  it('the stored reference rate is the account currency per unit of the quote currency, dated by its older quote', () => {
    // 0,92 EUR and 1,36 CAD per USD: 1 EUR = 1,0869… USD; 1 EUR = 1,4782… CAD.
    const fx = new FxTable().set('EUR', [{ date: '2026-10-01', perUsd: dec('0.92'), source: 'test' }]).set('CAD', [{ date: '2026-10-02', perUsd: dec('1.36'), source: 'test' }]);
    const usd = storedRate(fx, 'EUR', 'USD', '2026-10-05')!;
    expect(usd.rate.toDecimalPlaces(4).toString()).toBe('1.087');
    expect(usd.date).toBe('2026-10-01');
    expect(storedRate(fx, 'EUR', 'CAD', '2026-10-05')!.rate.toDecimalPlaces(4).toString()).toBe('1.4783');
    // No rate stored, or too old: no reference, never a made-up one.
    expect(storedRate(fx, 'GBP', 'USD', '2026-10-05')).toBeUndefined();
    expect(storedRate(fx, 'EUR', 'USD', '2026-12-31')).toBeUndefined();
  });

  it('a typed rate is checked against the stored one: close, upside down, or far', () => {
    expect(rateCheck(dec('1.08'), dec('1.087'))).toBe('ok');
    // 1,36 CAD per USD typed where USD per CAD (0,735) is asked.
    expect(rateCheck(dec('1.36'), dec('0.7353'))).toBe('inverted');
    expect(rateCheck(dec('1.30'), dec('1.087'))).toBe('far');
  });

  it('the rate is typed as brokers show it, above 1, and a peso or dollar-per rate divides', () => {
    // USD per EUR (1,087), but CAD per USD for a Toronto stock and COP per USD for a peso stock on a dollar account.
    expect(rateQuote('EUR', 'USD', dec('1.087'))).toEqual({ base: 'EUR', per: 'USD', inverted: false });
    expect(rateQuote('CAD', 'USD', dec('0.7353'))).toEqual({ base: 'USD', per: 'CAD', inverted: true });
    expect(rateQuote('COP', 'USD')).toEqual({ base: 'USD', per: 'COP', inverted: true });
    expect(rateQuote('USD', 'COP')).toEqual({ base: 'USD', per: 'COP', inverted: false });
    // By convention, not by what is stored: CAD per USD even with no CAD rate, USD per EUR whatever the level.
    expect(rateQuote('CAD', 'USD')).toEqual({ base: 'USD', per: 'CAD', inverted: true });
    expect(rateQuote('EUR', 'USD', dec('0.99'))).toEqual({ base: 'EUR', per: 'USD', inverted: false });
    expect(rateQuote('EUR', 'COP')).toEqual({ base: 'EUR', per: 'COP', inverted: false });
    // Two currencies of the same rank: the stored rate kept above 1 (1 CAD = 3.000 COP → COP per CAD).
    expect(rateQuote('CAD', 'COP', dec(3000))).toEqual({ base: 'CAD', per: 'COP', inverted: false });
    // 1.000 shares at 2.345 COP at 4.100 COP per USD = 2.345.000 / 4.100 = 571,951… → 571,95 USD; − fee 1 on a sale.
    expect(tradeTotal('BUY', dec(1000), dec(2345), undefined, dec(4100), true).toString()).toBe('571.95');
    expect(tradeTotal('SELL', dec(1000), dec(2345), dec(1), dec(4100), true).toString()).toBe('570.95');
    // 3 at 40 CAD at 1,37 CAD per USD: 120 / 1,37 = 87,5912… + 0,35 = 87,9412… → 87,94 USD.
    expect(tradeTotal('BUY', dec(3), dec(40), dec('0.35'), dec('1.37'), true).toString()).toBe('87.94');
  });
});
