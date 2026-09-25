import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// public/sw.js (client-012) run in a VM with a fake ServiceWorkerGlobalScope:
// headless Chromium cannot display notifications, so the handlers are checked
// here. On-device display stays DID NOT RUN (SYSTEM-CONTRACT).
const SOURCE = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://shop.example';

function load(windows: { url: string }[] = []) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    skipWaiting: vi.fn(),
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: {
      claim: vi.fn(),
      openWindow: async (url: string) => void opened.push(url),
      matchAll: async () =>
        windows.map((w) => ({ url: w.url, focus: async () => undefined, navigate: async (u: string) => (navigated.push(u), { focus: async () => undefined }) })),
    },
  };
  vm.runInNewContext(SOURCE, { self, URL });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  return { fire, shown, opened, navigated };
}

const pushEvent = (data: unknown) => ({ data: { json: () => (typeof data === 'string' ? JSON.parse(data) : data) } });

describe('service worker (public/sw.js)', () => {
  it('push: shows title, body, tag and link, in Hebrew RTL', async () => {
    const sw = load();
    await sw.fire('push', pushEvent({ title: 'New order K7Q2M', body: 'Tap to open.', url: '/admin/orders/x', tag: 'order-x' }));
    expect(sw.shown).toEqual([{ title: 'New order K7Q2M', options: { body: 'Tap to open.', tag: 'order-x', data: { url: '/admin/orders/x' }, lang: 'he', dir: 'rtl' } }]);
  });

  it('push: a payload without a title or that is not JSON shows nothing and does not throw', async () => {
    const sw = load();
    await sw.fire('push', pushEvent({ body: 'x' }));
    await sw.fire('push', { data: { json: () => JSON.parse('not json') } });
    await sw.fire('push', { data: null });
    expect(sw.shown).toEqual([]);
  });

  it('click: opens the link on this site; any other origin becomes the orders list', async () => {
    const sw = load();
    const click = (url: unknown) => sw.fire('notificationclick', { notification: { close: vi.fn(), data: { url } } });
    await click('/admin/orders/abc');
    await click('https://evil.test/phish');
    await click('javascript:alert(1)');
    expect(sw.opened).toEqual([`${ORIGIN}/admin/orders/abc`, `${ORIGIN}/admin/orders`, `${ORIGIN}/admin/orders`]);
  });

  it('click: reuses an open admin window instead of opening a new one', async () => {
    const sw = load([{ url: `${ORIGIN}/admin/capacity` }]);
    await sw.fire('notificationclick', { notification: { close: vi.fn(), data: { url: '/admin/orders/abc' } } });
    expect(sw.navigated).toEqual([`${ORIGIN}/admin/orders/abc`]);
    expect(sw.opened).toEqual([]);
  });
});
