// The cart (client-001). Client-side only, never persisted as an order (PRD
// section 5: `cart` is not a DB state). One order = one day (design-tokens.md,
// "הזמנה אחת, יום אחד"): the cart carries the day it belongs to. Checkout
// (client-003) reads the same shape from sessionStorage (CART_STORAGE_KEY).
// Whether the lines fit that day is decided by the DB at checkout
// (fn_reserve_capacity), never here.

export const CART_STORAGE_KEY = 'yb.cart.v1';
export const MAX_LINE_QUANTITY = 20;

export type CartLine = { productId: string; quantity: number };
export type Cart = { day: string | null; lines: CartLine[] };

export const EMPTY_CART: Cart = { day: null, lines: [] };

export function cartCount(cart: Cart): number {
  return cart.lines.reduce((n, l) => n + l.quantity, 0);
}

export function addToCart(cart: Cart, productId: string, day: string): Cart {
  const existing = cart.lines.find((l) => l.productId === productId);
  const lines = existing
    ? cart.lines.map((l) => (l.productId === productId ? { ...l, quantity: Math.min(MAX_LINE_QUANTITY, l.quantity + 1) } : l))
    : [...cart.lines, { productId, quantity: 1 }];
  return { day, lines };
}

/**
 * Set one line's quantity. Above MAX_LINE_QUANTITY it stays at the cap; 0 or
 * less removes the line. A product not in the cart is left alone (only
 * addToCart creates a line, because only it knows the day).
 */
export function setLineQuantity(cart: Cart, productId: string, quantity: number): Cart {
  if (!cart.lines.some((l) => l.productId === productId)) return cart;
  if (!Number.isFinite(quantity) || quantity < 1) return removeFromCart(cart, productId);
  const q = Math.min(MAX_LINE_QUANTITY, Math.floor(quantity));
  return { ...cart, lines: cart.lines.map((l) => (l.productId === productId ? { ...l, quantity: q } : l)) };
}

/** One more of a line already in the cart, capped at MAX_LINE_QUANTITY. */
export function incrementLine(cart: Cart, productId: string): Cart {
  const line = cart.lines.find((l) => l.productId === productId);
  return line ? setLineQuantity(cart, productId, line.quantity + 1) : cart;
}

/** One less of a line; at quantity 1 the line is removed. */
export function decrementLine(cart: Cart, productId: string): Cart {
  const line = cart.lines.find((l) => l.productId === productId);
  return line ? setLineQuantity(cart, productId, line.quantity - 1) : cart;
}

/** Remove a line. The day stays with the cart (the customer picked it). */
export function removeFromCart(cart: Cart, productId: string): Cart {
  if (!cart.lines.some((l) => l.productId === productId)) return cart;
  return { ...cart, lines: cart.lines.filter((l) => l.productId !== productId) };
}

/** The cart follows the selected day (one order, one day). */
export function moveCartToDay(cart: Cart, day: string): Cart {
  return cart.day === day ? cart : { ...cart, day };
}

/** Parse what sessionStorage holds; anything unexpected is an empty cart. */
export function parseCart(raw: string | null): Cart {
  if (!raw) return EMPTY_CART;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return EMPTY_CART;
    const { day, lines } = v as { day?: unknown; lines?: unknown };
    if (!(day === null || (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))) || !Array.isArray(lines)) return EMPTY_CART;
    const ok = lines.filter(
      (l): l is CartLine =>
        typeof l === 'object' && l !== null && typeof (l as CartLine).productId === 'string' &&
        Number.isInteger((l as CartLine).quantity) && (l as CartLine).quantity >= 1 && (l as CartLine).quantity <= MAX_LINE_QUANTITY,
    );
    return { day, lines: ok.map((l) => ({ productId: l.productId, quantity: l.quantity })) };
  } catch {
    return EMPTY_CART;
  }
}
