import { describe, expect, it } from 'vitest';
import { dec } from '../src/domain/money.ts';
import { editablePrice, field, impliedPrice, parseNum, tradeTotal } from '../src/app/trade.ts';

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
