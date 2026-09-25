'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

// client-012: turn web push on or off for THIS browser (admin only, SEC-018).
// Push is an extra: every notification also goes by email (US-10), so every
// failure path here says so and never blocks anything.

type State = 'checking' | 'not_configured' | 'unsupported' | 'denied' | 'off' | 'on';
type Message = { kind: 'ok' | 'error' | 'info'; key: 'enabled' | 'disabled' | 'dismissed' | 'failed' | 'unsubscribe_failed' };

const SW_URL = '/sw.js';
const SW_SCOPE = '/admin/';

function supported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** VAPID public key (base64url) to the bytes PushManager.subscribe expects. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  return reg ? reg.pushManager.getSubscription() : null;
}

export function PushSubscribeCard({ vapidPublicKey, deviceCount }: { vapidPublicKey: string | null; deviceCount: number }) {
  const t = useTranslations('admin.push');
  const tp = useTranslations('push');
  const [state, setState] = useState<State>('checking');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next: State;
      if (!vapidPublicKey) next = 'not_configured';
      else if (!supported()) next = 'unsupported';
      else if (Notification.permission === 'denied') next = 'denied';
      else {
        try {
          next = (await currentSubscription()) ? 'on' : 'off';
        } catch {
          next = 'off';
        }
      }
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [vapidPublicKey]);

  async function enable() {
    if (!vapidPublicKey) return;
    setMessage(null);
    // Ask first, inside the click: Safari only shows the prompt from a user gesture.
    let permission: NotificationPermission;
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = 'denied';
    }
    if (permission === 'denied') return setState('denied');
    if (permission !== 'granted') return setMessage({ kind: 'info', key: 'dismissed' });

    setBusy(true);
    let sub: PushSubscription | null = null;
    try {
      await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
      const reg = await navigator.serviceWorker.ready;
      sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) }));
      const json = sub.toJSON();
      const res = await fetch('/api/admin/push-subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
      if (!res.ok) throw new Error(`register ${res.status}`);
      setState('on');
      router.refresh(); // the device count comes from the server
      setMessage({ kind: 'ok', key: 'enabled' });
    } catch {
      // The server does not know this subscription, so the browser must not keep it either.
      await sub?.unsubscribe().catch(() => undefined);
      setState('off');
      setMessage({ kind: 'error', key: 'failed' });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMessage(null);
    try {
      const sub = await currentSubscription();
      if (sub) {
        const res = await fetch('/api/admin/push-subscriptions', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        if (!res.ok) throw new Error(`revoke ${res.status}`);
        await sub.unsubscribe();
      }
      setState('off');
      router.refresh();
      setMessage({ kind: 'ok', key: 'disabled' });
    } catch {
      setMessage({ kind: 'error', key: 'unsubscribe_failed' });
    } finally {
      setBusy(false);
    }
  }

  const messageText =
    message?.key === 'enabled' ? tp('enabled_confirmation') : message?.key === 'disabled' ? t('disabled_confirmation') : message ? t(message.key) : '';

  return (
    <section className="admin-cap admin-push" aria-labelledby="push-title" data-testid="push-card" data-state={state}>
      <h2 id="push-title" className="admin-section-title">
        {t('title')}
      </h2>
      <p className="admin-hint">{t('extra_note')}</p>

      {state === 'not_configured' || state === 'unsupported' || state === 'denied' ? (
        <p className="admin-push-note" role="status" data-testid="push-note">
          {t(state)}
        </p>
      ) : null}

      {state === 'on' || state === 'off' ? (
        <>
          <p className="admin-push-status">
            {t('status_label')} <b data-testid="push-status">{state === 'on' ? t('state_on') : t('state_off')}</b>
          </p>
          {state === 'off' ? <p className="admin-hint">{tp('permission_prompt')}</p> : null}
          <button
            type="button"
            className={state === 'on' ? 'btn btn-secondary admin-submit' : 'btn btn-primary admin-submit'}
            onClick={state === 'on' ? disable : enable}
            disabled={busy}
            data-testid="push-toggle"
          >
            {busy ? t('working') : state === 'on' ? t('disable') : t('enable')}
          </button>
        </>
      ) : null}

      {state === 'denied' ? (
        <button type="button" className="btn btn-secondary admin-submit" onClick={enable} disabled={busy} data-testid="push-toggle">
          {t('enable')}
        </button>
      ) : null}

      <p className="admin-hint" data-testid="push-devices">
        {t('devices', { count: deviceCount })}
      </p>
      <p
        className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'}
        role={message?.kind === 'error' ? 'alert' : 'status'}
        data-testid="push-message"
        hidden={!message}
      >
        {messageText}
      </p>
    </section>
  );
}
