import { describe, expect, it } from 'vitest';
import {
  addToCart,
  cartCount,
  decrementLine,
  EMPTY_CART,
  incrementLine,
  MAX_LINE_QUANTITY,
  moveCartToDay,
  parseCart,
  removeFromCart,
  setLineQuantity,
} from '@/lib/shared/cart';
import { isolatedDate, shortDate, weekdayKey } from '@/components/day-state/format';
import { formatIls } from '@/lib/shared/price/vat';

describe('cart (client-side, one day per order)', () => {
  it('adds lines, counts units, caps a line quantity', () => {
    let c = addToCart(EMPTY_CART, 'a', '2026-10-01');
    c = addToCart(c, 'a', '2026-10-01');
    c = addToCart(c, 'b', '2026-10-01');
    expect(c).toEqual({ day: '2026-10-01', lines: [{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }] });
    expect(cartCount(c)).toBe(3);
    for (let i = 0; i < 50; i++) c = addToCart(c, 'a', '2026-10-01');
    expect(c.lines[0]!.quantity).toBe(MAX_LINE_QUANTITY);
  });
  it('follows the selected day', () => {
    const c = addToCart(EMPTY_CART, 'a', '2026-10-01');
    expect(moveCartToDay(c, '2026-10-02').day).toBe('2026-10-02');
    expect(moveCartToDay(c, '2026-10-01')).toBe(c);
  });
  it('parses only a well-formed stored cart', () => {
    expect(parseCart(null)).toEqual(EMPTY_CART);
    expect(parseCart('{')).toEqual(EMPTY_CART);
    expect(parseCart('{"day":"x","lines":[]}')).toEqual(EMPTY_CART);
    expect(parseCart('{"day":"2026-10-01","lines":[{"productId":"a","quantity":2},{"productId":"b","quantity":0},{"quantity":1}]}')).toEqual({
      day: '2026-10-01',
      lines: [{ productId: 'a', quantity: 2 }],
    });
  });
});

describe('cart editing (minus, plus, remove)', () => {
  const day = '2026-10-01';
  const two = addToCart(addToCart(addToCart(EMPTY_CART, 'a', day), 'a', day), 'b', day);

  it('minus lowers a line by one; at 1 it removes the line; the day stays', () => {
    const c = decrementLine(two, 'a');
    expect(c.lines).toEqual([{ productId: 'a', quantity: 1 }, { productId: 'b', quantity: 1 }]);
    const d = decrementLine(c, 'a');
    expect(d).toEqual({ day, lines: [{ productId: 'b', quantity: 1 }] });
    expect(decrementLine(d, 'b')).toEqual({ day, lines: [] });
  });

  it('plus adds one and stops at MAX_LINE_QUANTITY', () => {
    let c = incrementLine(two, 'b');
    expect(c.lines[1]).toEqual({ productId: 'b', quantity: 2 });
    for (let i = 0; i < 40; i++) c = incrementLine(c, 'b');
    expect(c.lines[1]!.quantity).toBe(MAX_LINE_QUANTITY);
    expect(incrementLine(c, 'b')).toEqual(c);
  });

  it('plus and minus leave a product that is not in the cart alone (only add creates a line)', () => {
    expect(incrementLine(two, 'zz')).toBe(two);
    expect(decrementLine(two, 'zz')).toBe(two);
    expect(removeFromCart(two, 'zz')).toBe(two);
    expect(setLineQuantity(two, 'zz', 3)).toBe(two);
  });

  it('setLineQuantity caps, floors, and removes at 0 or below or on a non-number', () => {
    expect(setLineQuantity(two, 'a', 99).lines[0]).toEqual({ productId: 'a', quantity: MAX_LINE_QUANTITY });
    expect(setLineQuantity(two, 'a', 3.7).lines[0]).toEqual({ productId: 'a', quantity: 3 });
    expect(setLineQuantity(two, 'a', 0).lines).toEqual([{ productId: 'b', quantity: 1 }]);
    expect(setLineQuantity(two, 'a', -2).lines).toEqual([{ productId: 'b', quantity: 1 }]);
    expect(setLineQuantity(two, 'a', Number.NaN).lines).toEqual([{ productId: 'b', quantity: 1 }]);
  });

  it('remove drops the whole line whatever its quantity, and never mutates the input', () => {
    const before = JSON.stringify(two);
    expect(removeFromCart(two, 'a')).toEqual({ day, lines: [{ productId: 'b', quantity: 1 }] });
    expect(cartCount(removeFromCart(removeFromCart(two, 'a'), 'b'))).toBe(0);
    expect(JSON.stringify(two)).toBe(before);
  });

  it('an edited cart round-trips through parseCart (what sessionStorage holds)', () => {
    const c = incrementLine(decrementLine(two, 'a'), 'b');
    expect(parseCart(JSON.stringify(c))).toEqual(c);
    expect(parseCart(JSON.stringify(removeFromCart(removeFromCart(two, 'a'), 'b')))).toEqual({ day, lines: [] });
  });
});

describe('day and price formatting', () => {
  it('weekday of a calendar date, Israeli short date', () => {
    expect(weekdayKey('2026-10-01')).toBe('thu');
    expect(weekdayKey('2026-10-03')).toBe('sat');
    expect(shortDate('2026-10-01')).toBe('1.10');
  });
  it('isolates the date for running Hebrew text (LRI ... PDI)', () => {
    expect(isolatedDate('2026-09-28')).toBe('⁦28.9⁩');
  });
  it('price: whole shekels without decimals, otherwise two, then the shekel sign', () => {
    expect(formatIls(120)).toBe('120 ₪');
    expect(formatIls(145.5)).toBe('145.50 ₪');
    expect(formatIls(1200)).toBe('1,200 ₪');
  });
});
