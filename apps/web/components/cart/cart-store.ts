'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { CART_STORAGE_KEY, EMPTY_CART, parseCart, type Cart } from '@/lib/shared/cart';

// sessionStorage-backed cart store. The server render always sees an empty
// cart (getServerSnapshot), so the first frame never depends on the browser.

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedCart: Cart = EMPTY_CART;

function read(): Cart {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(CART_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedCart = parseCart(raw);
  }
  return cachedCart;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useCart(): [Cart, (next: (c: Cart) => Cart) => void] {
  const cart = useSyncExternalStore(subscribe, read, () => EMPTY_CART);
  const update = useCallback((next: (c: Cart) => Cart) => {
    const value = next(read());
    try {
      window.sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Private mode or storage full: the cart still lives for this page view.
      cachedRaw = JSON.stringify(value);
      cachedCart = value;
    }
    for (const l of listeners) l();
  }, []);
  return [cart, update];
}
