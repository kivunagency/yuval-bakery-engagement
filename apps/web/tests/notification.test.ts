import { describe, expect, it, vi } from 'vitest';
import { dispatch, emailHash, type NotifierDeps } from '@/lib/server/notification/dispatch';
import type { BeginResult, CustomCakeFactsRow, NotificationStore, OrderFactsRow, PaymentLinksFactsRow } from '@/lib/server/notification/store';
import type { EmailMessage, EmailProvider } from '@/lib/server/notification/email/provider';
import { resendProvider } from '@/lib/server/notification/email/provider';
import type { PushSender } from '@/lib/server/notification/push/sender';
import { readNotificationConfig } from '@/lib/server/notification/config';
import { isAllowedPushEndpoint, pushSubscriptionBody } from '@/lib/shared/contracts/push';
import { safeCustomerName, escapeHtml } from '@/lib/server/notification/templates';
import type { PushPayload } from '@/lib/shared/contracts/push';
import { formatPrice } from '@/components/price/Price';
import he from '@/messages/he.json';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const REQ_ID = '22222222-2222-4222-8222-222222222222';
const SUB_ID = '33333333-3333-4333-8333-333333333333';

const order = (over: Partial<OrderFactsRow> = {}): OrderFactsRow => ({
  order_id: ORDER_ID, order_number: 'K7Q2M', status: 'payment_pending', order_source: 'standard',
  customer_name: 'Dana <b>Levi</b>', customer_email: 'dana@example.test', fulfillment_type: 'delivery',
  delivery_date: '2026-10-14', total_displayed: 180, payment_pending_expires_at: null, ...over,
});

const cake = (over: Partial<CustomCakeFactsRow> = {}): CustomCakeFactsRow => ({
  request_id: REQ_ID, status: 'pending_review', requester_name: 'Noa', requester_email: 'noa@example.test',
  desired_date: '2026-10-20', price_displayed: null, decline_reason: null, order_id: null, order_number: null,
  payment_pending_expires_at: null, ...over,
});

const CHANGE_ID = '33333333-3333-4333-8333-333333333333';
const links = (over: Partial<PaymentLinksFactsRow> = {}): PaymentLinksFactsRow => ({
  change_id: CHANGE_ID, changed_at: '2026-10-14T10:00:00Z', admin_name: 'QA admin', bit_changed: true, paybox_changed: true,
  bit_link: 'https://www.bitpay.co.il/app/me/<script>', paybox_link: null, ...over,
});

function fakes(opts: { order?: OrderFactsRow | null; cake?: CustomCakeFactsRow | null; links?: PaymentLinksFactsRow | null; begin?: (n: number) => Partial<BeginResult>; emailFails?: boolean } = {}) {
  const emails: EmailMessage[] = [];
  const pushes: PushPayload[] = [];
  const finished: { id: string; status: string; reason: string | null }[] = [];
  const skipped: { channel: string; audience: string; reason: string }[] = [];
  let n = 0;
  const store: NotificationStore = {
    orderFacts: async () => (opts.order === undefined ? order() : opts.order),
    customCakeFacts: async () => (opts.cake === undefined ? cake() : opts.cake),
    paymentLinksFacts: async () => (opts.links === undefined ? links() : opts.links),
    adminEmails: async () => ['yuval@example.test'],
    business: async () => ({ name: null, phone: null }),
    activePushSubscriptions: async () => [{ id: SUB_ID, endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'k', auth_key: 'a' }],
    begin: async () => {
      n += 1;
      return { attempt_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, allowed: true, reason: null, alert: false, sent_today: n, hard_cap: 100, ...(opts.begin?.(n) ?? {}) };
    },
    finish: async (id, status, reason) => void finished.push({ id, status, reason }),
    skipped: async (k, reason) => void skipped.push({ channel: k.channel, audience: k.audience, reason }),
    pushResult: async () => undefined,
  };
  const email: EmailProvider = {
    name: 'capture',
    send: async (m) => {
      emails.push(m);
      return opts.emailFails ? { ok: false, error: 'resend_http_500' } : { ok: true, id: `id-${emails.length}` };
    },
  };
  const push: PushSender = { send: async (_t, p) => (pushes.push(p), { ok: true }) };
  const deps: NotifierDeps = { store, email, emailOffReason: '', push, siteUrl: 'https://shop.example' };
  return { deps, emails, pushes, finished, skipped };
}

describe('OrderCreated', () => {
  it('push + email to the admin; customer email waits for the PDF (recorded as skipped)', async () => {
    const f = fakes();
    const report = await dispatch({ event: 'order_created', entityId: ORDER_ID }, f.deps);
    expect(report.outcomes).toEqual([
      { channel: 'push', audience: 'admin', status: 'sent', reason: null },
      { channel: 'email', audience: 'admin', status: 'sent', reason: null },
      { channel: 'email', audience: 'customer', status: 'skipped', reason: 'confirmation_pdf_pending' },
    ]);
    expect(f.skipped).toEqual([{ channel: 'email', audience: 'customer', reason: 'confirmation_pdf_pending' }]);
    const admin = f.emails[0]!;
    expect(admin.to).toBe('yuval@example.test');
    expect(admin.subject).toContain('K7Q2M');
    expect(admin.html).toContain('https://shop.example/admin/orders/' + ORDER_ID);
    // the name is there (US-10) and escaped (SEC-025)
    expect(admin.html).toContain('Dana &lt;b&gt;Levi&lt;/b&gt;');
    expect(admin.html).not.toContain('<b>Levi');
    expect(admin.html).toContain('dir="rtl"');
  });

  it('push payload: order number and link only, no name (SEC-018)', async () => {
    const f = fakes();
    await dispatch({ event: 'order_created', entityId: ORDER_ID }, f.deps);
    expect(f.pushes).toHaveLength(1);
    const p = JSON.stringify(f.pushes[0]);
    expect(p).toContain('K7Q2M');
    expect(p).toContain('/admin/orders/' + ORDER_ID);
    expect(p).not.toContain('Dana');
    expect(p).not.toContain('dana@');
  });

  it('with the PDF: customer confirmation sent, attachment carried, no customer text in it', async () => {
    const f = fakes();
    const pdf = { filename: 'order-K7Q2M.pdf', content: new Uint8Array([37, 80, 68, 70]) };
    const report = await dispatch({ event: 'order_created', entityId: ORDER_ID, confirmationPdf: pdf }, f.deps);
    expect(report.outcomes.at(-1)).toEqual({ channel: 'email', audience: 'customer', status: 'sent', reason: null });
    const customer = f.emails.find((m) => m.to === 'dana@example.test')!;
    expect(customer.attachments).toEqual([pdf]);
    expect(customer.html + customer.text + customer.subject).not.toContain('Dana');
    // placeholder business name, never invented
    expect(customer.text).toContain(he.business.details.name);
  });

  it('no customer email: skipped, nothing sent to the customer', async () => {
    const f = fakes({ order: order({ customer_email: null }) });
    const report = await dispatch({ event: 'order_created', entityId: ORDER_ID }, f.deps);
    expect(report.outcomes.at(-1)).toEqual({ channel: 'email', audience: 'customer', status: 'skipped', reason: 'no_customer_email' });
  });

  it('a failing provider is recorded as failed and never throws', async () => {
    const f = fakes({ emailFails: true });
    const report = await dispatch({ event: 'order_created', entityId: ORDER_ID }, f.deps);
    expect(report.outcomes.find((o) => o.channel === 'email' && o.audience === 'admin')).toEqual({ channel: 'email', audience: 'admin', status: 'failed', reason: 'resend_http_500' });
    expect(f.finished.some((x) => x.status === 'failed' && x.reason === 'resend_http_500')).toBe(true);
  });

  it('a broken DB never rejects: the report says failed', async () => {
    const f = fakes();
    f.deps.store.orderFacts = async () => {
      throw new Error('connection refused');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(dispatch({ event: 'order_created', entityId: ORDER_ID }, f.deps)).resolves.toMatchObject({ outcomes: [{ status: 'failed', reason: 'internal_error' }] });
    err.mockRestore();
  });

  it('one channel failing inside the DB does not stop the next', async () => {
    const f = fakes();
    f.deps.store.activePushSubscriptions = async () => {
      throw new Error('boom');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const report = await dispatch({ event: 'order_created', entityId: ORDER_ID }, f.deps);
    err.mockRestore();
    expect(report.outcomes[0]).toEqual({ channel: 'push', audience: 'admin', status: 'failed', reason: 'internal_error' });
    expect(report.outcomes[1]).toEqual({ channel: 'email', audience: 'admin', status: 'sent', reason: null });
  });

  it('refusals and duplicates from the DB are reported, nothing sent', async () => {
    const f = fakes({ begin: () => ({ attempt_id: null, allowed: false, reason: 'daily_cap' }) });
    const report = await dispatch({ event: 'order_created', entityId: ORDER_ID }, f.deps);
    expect(f.emails).toHaveLength(0);
    expect(report.outcomes[1]).toEqual({ channel: 'email', audience: 'admin', status: 'refused', reason: 'daily_cap' });
    const g = fakes({ begin: () => ({ attempt_id: null, allowed: false, reason: 'duplicate' }) });
    const r2 = await dispatch({ event: 'order_created', entityId: ORDER_ID }, g.deps);
    expect(r2.outcomes[0]).toMatchObject({ status: 'duplicate' });
  });

  it('crossing the alert threshold sends one quota push to the admin', async () => {
    // begin #1 is the order push, #2 the admin email (alert), #3 the alert push
    const f = fakes({ begin: (n) => (n === 2 ? { alert: true, sent_today: 80, hard_cap: 100 } : {}) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await dispatch({ event: 'order_created', entityId: ORDER_ID }, f.deps);
    warn.mockRestore();
    expect(f.pushes).toHaveLength(2);
    expect(f.pushes[1]!.title).toContain('80');
    expect(f.pushes[1]!.url).toBe('https://shop.example/admin/settings');
  });

  it('email not configured: recorded as skipped with the reason', async () => {
    const f = fakes();
    f.deps.email = null;
    f.deps.emailOffReason = 'email_provider_not_configured';
    f.deps.push = null;
    const report = await dispatch({ event: 'order_created', entityId: ORDER_ID }, f.deps);
    expect(report.outcomes.slice(0, 2)).toEqual([
      { channel: 'push', audience: 'admin', status: 'skipped', reason: 'push_not_configured' },
      { channel: 'email', audience: 'admin', status: 'skipped', reason: 'email_provider_not_configured' },
    ]);
  });

  it('a non-uuid id is refused before any DB call', async () => {
    const f = fakes();
    const spy = vi.spyOn(f.deps.store, 'orderFacts');
    const report = await dispatch({ event: 'order_created', entityId: 'x; drop' }, f.deps);
    expect(spy).not.toHaveBeenCalled();
    expect(report.outcomes).toEqual([{ channel: 'email', audience: 'admin', status: 'skipped', reason: 'invalid_entity_id' }]);
  });
});

describe('custom cake events', () => {
  it('requested: push + email to the admin, link to the request', async () => {
    const f = fakes();
    const report = await dispatch({ event: 'custom_cake_requested', entityId: REQ_ID }, f.deps);
    expect(report.outcomes.map((o) => `${o.channel}/${o.audience}/${o.status}`)).toEqual(['push/admin/sent', 'email/admin/sent']);
    expect(f.emails[0]!.html).toContain('/admin/custom-cakes/' + REQ_ID);
    expect(JSON.stringify(f.pushes[0])).not.toContain('Noa');
  });

  it('approved: customer email with price and order number, no customer text', async () => {
    const f = fakes({ cake: cake({ status: 'approved', price_displayed: 350, order_id: ORDER_ID, order_number: 'C9X4T', payment_pending_expires_at: '2026-10-15T13:00:00Z' }) });
    const report = await dispatch({ event: 'custom_cake_approved', entityId: REQ_ID }, f.deps);
    expect(report.outcomes).toEqual([{ channel: 'email', audience: 'customer', status: 'sent', reason: null }]);
    const m = f.emails[0]!;
    expect(m.to).toBe('noa@example.test');
    expect(m.subject).toContain('C9X4T');
    expect(m.text).toContain(formatPrice(350));
    expect(m.text).toContain('15.10, 16:00'); // 13:00Z is 16:00 in Jerusalem (IDT)
    expect(m.text + m.html).not.toContain('Noa');
  });

  it('approved but not in that state (or no order yet): skipped, nothing sent', async () => {
    const f = fakes({ cake: cake({ status: 'pending_review' }) });
    const report = await dispatch({ event: 'custom_cake_approved', entityId: REQ_ID }, f.deps);
    expect(report.outcomes).toEqual([{ channel: 'email', audience: 'customer', status: 'skipped', reason: 'entity_not_in_expected_state' }]);
    expect(f.emails).toHaveLength(0);
  });

  it('declined: the admin reason is escaped; no reason means no reason line', async () => {
    const f = fakes({ cake: cake({ status: 'declined', decline_reason: 'Fully booked <script>x</script>' }) });
    await dispatch({ event: 'custom_cake_declined', entityId: REQ_ID }, f.deps);
    expect(f.emails[0]!.html).toContain('Fully booked &lt;script&gt;');
    expect(f.emails[0]!.html).not.toContain('<script>');
    const g = fakes({ cake: cake({ status: 'declined', decline_reason: null }) });
    await dispatch({ event: 'custom_cake_declined', entityId: REQ_ID }, g.deps);
    expect(g.emails[0]!.text).not.toContain(he.notification.custom_cake_declined.reason.split('{')[0]!.trim());
  });

  it('declined without an email: skipped (Yuval uses WhatsApp click-to-send)', async () => {
    const f = fakes({ cake: cake({ status: 'declined', requester_email: null }) });
    const report = await dispatch({ event: 'custom_cake_declined', entityId: REQ_ID }, f.deps);
    expect(report.outcomes).toEqual([{ channel: 'email', audience: 'customer', status: 'skipped', reason: 'no_customer_email' }]);
  });
});

describe('templates', () => {
  it('a name that looks like a link is hidden (SEC-015); controls stripped; 60 chars max', () => {
    expect(safeCustomerName('You won! go to evil.co')).not.toContain('evil');
    expect(safeCustomerName('https://x.test')).not.toContain('x.test');
    expect(safeCustomerName('a‮b')).toBe('a b');
    expect(safeCustomerName('x'.repeat(100))).toHaveLength(60);
    expect(safeCustomerName('')).not.toBe('');
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });

  it('recipient hash is case- and space-insensitive', () => {
    expect(emailHash(' Dana@Example.TEST ')).toBe(emailHash('dana@example.test'));
    expect(emailHash('a@b.c')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('config', () => {
  it('local defaults to capture; prod never captures; resend needs key and from', () => {
    expect(readNotificationConfig({ APP_ENV: 'local' }).email.provider).toBe('capture');
    expect(readNotificationConfig({ APP_ENV: 'prod', EMAIL_PROVIDER: 'capture' }).email).toEqual({ provider: 'none', reason: 'email_capture_refused_in_prod' });
    expect(readNotificationConfig({ APP_ENV: 'prod', RESEND_API_KEY: 're_1234567890' }).email).toEqual({ provider: 'none', reason: 'email_from_not_configured' });
    expect(readNotificationConfig({ APP_ENV: 'prod' }).email).toEqual({ provider: 'none', reason: 'email_provider_not_configured' });
    expect(readNotificationConfig({ APP_ENV: 'dev', RESEND_API_KEY: 're_1234567890', EMAIL_FROM: 'Shop <o@x.test>' }).email.provider).toBe('resend');
  });

  it('push needs all three VAPID values; local endpoints only on the local stack', () => {
    expect(readNotificationConfig({ APP_ENV: 'prod' }).push).toEqual({ enabled: false, reason: 'push_not_configured', allowLocalEndpoints: false });
    expect(readNotificationConfig({ APP_ENV: 'prod', PUSH_ALLOW_LOCAL_ENDPOINTS: '1' }).push.allowLocalEndpoints).toBe(false);
    expect(readNotificationConfig({ APP_ENV: 'local', PUSH_ALLOW_LOCAL_ENDPOINTS: '1' }).push.allowLocalEndpoints).toBe(true);
  });
});

describe('push endpoint allowlist (SSRF guard)', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/abc', true],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc', true],
    ['https://web.push.apple.com/abc', true],
    ['https://wns2-par02p.notify.windows.com/w/?token=abc', true],
    ['http://fcm.googleapis.com/fcm/send/abc', false],
    ['https://fcm.googleapis.com:8443/x', false],
    ['https://evil.test/fcm.googleapis.com', false],
    ['https://fcm.googleapis.com.evil.test/x', false],
    ['https://user:pw@fcm.googleapis.com/x', false],
    ['http://127.0.0.1:9999/x', false],
    ['http://169.254.169.254/latest', false],
    ['not a url', false],
  ])('%s -> %s', (url, ok) => {
    expect(isAllowedPushEndpoint(url)).toBe(ok);
  });

  it('local endpoints only with allowLocal', () => {
    expect(isAllowedPushEndpoint('http://127.0.0.1:9999/x', { allowLocal: true })).toBe(true);
    expect(isAllowedPushEndpoint('http://10.0.0.1/x', { allowLocal: true })).toBe(false);
  });

  it('subscription body is strict', () => {
    const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
    expect(pushSubscriptionBody.safeParse({ endpoint: 'https://fcm.googleapis.com/x', keys }).success).toBe(true);
    expect(pushSubscriptionBody.safeParse({ endpoint: 'https://fcm.googleapis.com/x', keys, admin_id: 'x' }).success).toBe(false);
    expect(pushSubscriptionBody.safeParse({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: 'a/b' } }).success).toBe(false);
  });
});

describe('resend adapter', () => {
  it('posts the message with a base64 attachment and returns the id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 're-1' }), { status: 200 }));
    const p = resendProvider('re_key_123456', 'Shop <o@x.test>', fetchMock as unknown as typeof fetch);
    const r = await p.send({ to: 'a@b.test', subject: 's', html: '<p>h</p>', text: 'h', attachments: [{ filename: 'c.pdf', content: new Uint8Array([1, 2, 3]) }] });
    expect(r).toEqual({ ok: true, id: 're-1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_key_123456');
    expect(JSON.parse(init.body as string)).toMatchObject({ from: 'Shop <o@x.test>', to: ['a@b.test'], attachments: [{ filename: 'c.pdf', content: 'AQID' }] });
  });

  it('keeps only the HTTP status on failure (the body may echo the address)', async () => {
    const p = resendProvider('re_key_123456', 'f', (async () => new Response('{"message":"a@b.test is invalid"}', { status: 422 })) as unknown as typeof fetch);
    expect(await p.send({ to: 'a@b.test', subject: 's', html: 'h', text: 'h' })).toEqual({ ok: false, error: 'resend_http_422' });
    const q = resendProvider('re_key_123456', 'f', (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    expect(await q.send({ to: 'a@b.test', subject: 's', html: 'h', text: 'h' })).toEqual({ ok: false, error: 'resend_network_error' });
  });
});

describe('PaymentLinksChanged (SEC-009)', () => {
  it('push + email to every admin with the new links as escaped text; a removed link says so', async () => {
    const f = fakes();
    const report = await dispatch({ event: 'payment_links_changed', entityId: CHANGE_ID }, f.deps);
    expect(report.outcomes).toEqual([
      { channel: 'push', audience: 'admin', status: 'sent', reason: null },
      { channel: 'email', audience: 'admin', status: 'sent', reason: null },
    ]);
    const [mail] = f.emails;
    expect(mail?.to).toBe('yuval@example.test');
    expect(mail?.text).toContain('https://www.bitpay.co.il/app/me/<script>');
    expect(mail?.html).toContain('&lt;script&gt;');
    expect(mail?.html).not.toContain('<a href="https://www.bitpay');
    expect(mail?.text).toContain('PayBox');
    expect(mail?.text).toContain('https://shop.example/admin/settings/payment');
    expect(f.pushes[0]).toMatchObject({ url: 'https://shop.example/admin/settings/payment', tag: 'payment-links' });
    expect(JSON.stringify(f.pushes[0])).not.toContain('bitpay');
  });

  it('an unknown change id sends nothing and is recorded as skipped', async () => {
    const f = fakes({ links: null });
    const report = await dispatch({ event: 'payment_links_changed', entityId: CHANGE_ID }, f.deps);
    expect(report.outcomes).toEqual([{ channel: 'email', audience: 'admin', status: 'skipped', reason: 'entity_not_found' }]);
    expect(f.emails).toEqual([]);
  });
});
