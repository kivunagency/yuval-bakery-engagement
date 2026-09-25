import { describe, expect, it } from 'vitest';
import { addToCart, cartCount, EMPTY_CART, MAX_LINE_QUANTITY, moveCartToDay, parseCart } from '@/lib/shared/cart';
import { isolatedDate, shortDate, weekdayKey } from '@/components/day-state/format';
import { formatPrice } from '@/components/price/Price';

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
    expect(formatPrice(120)).toBe('120 ₪');
    expect(formatPrice(145.5)).toBe('145.50 ₪');
    expect(formatPrice(1200)).toBe('1,200 ₪');
  });
});
