'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { NotesFieldHint } from '@/components/compliance';
import {
  CUSTOM_CAKE_LIMITS,
  CUSTOM_CAKE_PHOTO_TYPES,
  customCakeSubmit,
  customCakeSubmitResponse,
  customCakePhotosResponse,
  type CustomCakeApiErrorBody,
} from '@/lib/shared/contracts/custom-cake';
import styles from './custom-cake.module.css';

// Custom-cake request form (client-002, PRD US-2). The page above it is a
// server component that renders the privacy notice first (s.11) and passes
// the earliest date the DB will accept; the DB still decides (lead-time
// trigger), this only sets the date picker's minimum. Validation runs the same
// Zod contract as the API, then: POST the request, PUT each photo to its
// signed Storage URL, ask the server to re-encode them, show the confirmation.

type Field = 'name' | 'phone' | 'email' | 'desiredDate' | 'inscription' | 'notes' | 'photos' | 'uploadRightsConfirmed';
type FormError = 'rate_limited' | 'unavailable' | null;

const FIELD_OF: Record<string, Field> = {
  name: 'name', phone: 'phone', email: 'email', desiredDate: 'desiredDate', inscription: 'inscription',
  notes: 'notes', photos: 'photos', uploadRightsConfirmed: 'uploadRightsConfirmed',
};

export function CustomCakeForm({ earliestDate }: { earliestDate: string }) {
  const t = useTranslations('custom_cake.form');
  const router = useRouter();
  const ids = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<FormError>(null);
  const [busy, setBusy] = useState(false);
  const [inscriptionLen, setInscriptionLen] = useState(0);

  const id = (f: string) => `${ids}-${f}`;
  const describedBy = (f: Field, hint?: string) => [hint, errors[f] ? id(`${f}-error`) : null].filter(Boolean).join(' ') || undefined;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const files = (fileRef.current?.files ? [...fileRef.current.files] : []).slice(0, CUSTOM_CAKE_LIMITS.photos + 1);
    const candidate = {
      name: String(form.get('name') ?? ''),
      phone: String(form.get('phone') ?? ''),
      email: String(form.get('email') ?? ''),
      whatsappFollowupOk: form.get('whatsappFollowupOk') === 'on',
      desiredDate: String(form.get('desiredDate') ?? ''),
      inscription: String(form.get('inscription') ?? ''),
      notes: String(form.get('notes') ?? ''),
      uploadRightsConfirmed: form.get('uploadRightsConfirmed') === 'on',
      photos: files.map((f) => ({ type: f.type, size: f.size })),
    };

    const parsed = customCakeSubmit.safeParse(candidate);
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = FIELD_OF[String(issue.path[0])];
        if (field && !next[field]) next[field] = t(`errors.${field}`);
      }
      if (candidate.desiredDate && candidate.desiredDate < earliestDate) next.desiredDate = t('errors.too_soon');
      setErrors(next);
      setFormError(null);
      focusFirst(next);
      return;
    }
    if (parsed.data.desiredDate < earliestDate) {
      setErrors({ desiredDate: t('errors.too_soon') });
      focusFirst({ desiredDate: 'x' });
      return;
    }

    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/custom-cake-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Partial<CustomCakeApiErrorBody>;
        if (body.error === 'lead_time_not_met') {
          setErrors({ desiredDate: t('errors.too_soon') });
          focusFirst({ desiredDate: 'x' });
        } else setFormError(body.error === 'rate_limited' ? 'rate_limited' : 'unavailable');
        return;
      }
      const created = customCakeSubmitResponse.parse(await res.json());
      const photos = await uploadPhotos(created.requestId, created.uploads.map((u) => u.url), files, created.photosUnavailable);
      router.push(`/custom-cake/sent${photos === 'ok' ? '' : `?photos=${photos}`}`);
    } catch {
      setFormError('unavailable');
    } finally {
      setBusy(false);
    }
  }

  function focusFirst(next: Partial<Record<Field, string>>) {
    const order: Field[] = ['name', 'phone', 'email', 'desiredDate', 'inscription', 'notes', 'photos', 'uploadRightsConfirmed'];
    const first = order.find((f) => next[f]);
    if (first) requestAnimationFrame(() => document.getElementById(id(first))?.focus());
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate aria-busy={busy}>
      <fieldset className={styles.group}>
        <legend>{t('contact_legend')}</legend>
        <TextField id={id('name')} name="name" label={t('name')} autoComplete="name" maxLength={CUSTOM_CAKE_LIMITS.name} error={errors.name} errorId={id('name-error')} describedBy={describedBy('name')} required />
        <TextField id={id('phone')} name="phone" label={t('phone')} hint={t('phone_hint')} hintId={id('phone-hint')} type="tel" inputMode="tel" autoComplete="tel" dir="ltr" maxLength={20} error={errors.phone} errorId={id('phone-error')} describedBy={describedBy('phone', id('phone-hint'))} required />
        <TextField id={id('email')} name="email" label={t('email')} hint={t('email_hint')} hintId={id('email-hint')} type="email" autoComplete="email" dir="ltr" maxLength={254} error={errors.email} errorId={id('email-error')} describedBy={describedBy('email', id('email-hint'))} />
        <label className={styles.check}>
          <input type="checkbox" name="whatsappFollowupOk" />
          <span>{t('whatsapp_ok')}</span>
        </label>
      </fieldset>

      <fieldset className={styles.group}>
        <legend>{t('cake_legend')}</legend>
        <TextField id={id('desiredDate')} name="desiredDate" label={t('date')} hint={t('date_hint')} hintId={id('date-hint')} type="date" min={earliestDate} error={errors.desiredDate} errorId={id('desiredDate-error')} describedBy={describedBy('desiredDate', id('date-hint'))} required />
        <div className={styles.field}>
          <label htmlFor={id('inscription')}>{t('inscription')}</label>
          <input
            id={id('inscription')}
            name="inscription"
            className={styles.input}
            maxLength={CUSTOM_CAKE_LIMITS.inscription}
            aria-invalid={errors.inscription ? true : undefined}
            aria-describedby={describedBy('inscription', id('inscription-count'))}
            onChange={(e) => setInscriptionLen(e.currentTarget.value.length)}
          />
          <p id={id('inscription-count')} className={styles.hint}>
            {t('inscription_count', { used: inscriptionLen, max: CUSTOM_CAKE_LIMITS.inscription })}
          </p>
          <FieldError id={id('inscription-error')} message={errors.inscription} />
        </div>
        <div className={styles.field}>
          <label htmlFor={id('notes')}>{t('notes')}</label>
          <textarea
            id={id('notes')}
            name="notes"
            rows={4}
            className={styles.input}
            maxLength={CUSTOM_CAKE_LIMITS.notes}
            aria-invalid={errors.notes ? true : undefined}
            aria-describedby={describedBy('notes', id('notes-hint'))}
          />
          <NotesFieldHint id={id('notes-hint')} />
          <FieldError id={id('notes-error')} message={errors.notes} />
        </div>
      </fieldset>

      <fieldset className={styles.group}>
        <legend>{t('photos_legend')}</legend>
        <div className={styles.field}>
          <label htmlFor={id('photos')}>{t('upload_photo')}</label>
          <input
            ref={fileRef}
            id={id('photos')}
            name="photos"
            type="file"
            multiple
            accept={CUSTOM_CAKE_PHOTO_TYPES.join(',')}
            className={styles.file}
            aria-invalid={errors.photos ? true : undefined}
            aria-describedby={describedBy('photos', id('photos-hint'))}
          />
          <p id={id('photos-hint')} className={styles.hint}>
            {t('photos_hint', { max: CUSTOM_CAKE_LIMITS.photos, mb: CUSTOM_CAKE_LIMITS.photoBytes / 1024 / 1024 })}
          </p>
          <FieldError id={id('photos-error')} message={errors.photos} />
        </div>
        <label className={styles.check}>
          <input
            id={id('uploadRightsConfirmed')}
            type="checkbox"
            name="uploadRightsConfirmed"
            required
            aria-invalid={errors.uploadRightsConfirmed ? true : undefined}
            aria-describedby={errors.uploadRightsConfirmed ? id('uploadRightsConfirmed-error') : undefined}
          />
          <span>{t('upload_rights')}</span>
        </label>
        <FieldError id={id('uploadRightsConfirmed-error')} message={errors.uploadRightsConfirmed} />
      </fieldset>

      <p className={styles.noHold}>{t('no_hold')}</p>
      {formError ? (
        <p className={styles.formError} role="alert">
          {t(`errors.${formError}`)}
        </p>
      ) : null}
      <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={busy}>
        {busy ? t('sending') : t('submit')}
      </button>
    </form>
  );
}

/** PUT each file to its signed URL, then ask the server to re-encode them. */
async function uploadPhotos(requestId: string, urls: string[], files: File[], unavailable: boolean): Promise<'ok' | 'unavailable' | 'partial'> {
  if (files.length === 0) return 'ok';
  if (unavailable || urls.length === 0) return 'unavailable';
  let failed = 0;
  await Promise.all(
    urls.map(async (url, i) => {
      const file = files[i];
      if (!file) return;
      const put = await fetch(url, { method: 'PUT', body: file, headers: { 'content-type': file.type } }).catch(() => null);
      if (!put?.ok) failed += 1;
    }),
  );
  const fin = await fetch(`/api/custom-cake-requests/${requestId}/photos`, { method: 'POST' }).catch(() => null);
  if (!fin?.ok) return 'unavailable';
  const counts = customCakePhotosResponse.safeParse(await fin.json().catch(() => null));
  if (!counts.success) return 'unavailable';
  if (counts.data.accepted === 0) return 'unavailable';
  return failed > 0 || counts.data.rejected > 0 ? 'partial' : 'ok';
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className={styles.error}>
      {message}
    </p>
  );
}

type TextFieldProps = {
  id: string;
  name: string;
  label: string;
  hint?: string;
  hintId?: string;
  error?: string;
  errorId: string;
  describedBy?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'name'>;

function TextField({ id, name, label, hint, hintId, error, errorId, describedBy, ...input }: TextFieldProps) {
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <input id={id} name={name} className={styles.input} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId} message={error} />
    </div>
  );
}
