'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PRODUCT_LIMITS, type AdminProduct, type AdminProductPhoto, type PhotoUploadUrl } from '@/lib/shared/contracts/admin-products';
import { errorText, send, type Translate } from '@/components/admin/products/api';

// Product photos (client-006, SEC-011). Upload: ask the server for a signed
// URL into the private staging bucket, PUT the file there (no function body
// limit), then ask the server to re-encode it into the public bucket with its
// alt text. Every photo shows its alt text field: a published product needs
// one on every photo (the DB refuses otherwise).

const ACCEPT = 'image/jpeg,image/png,image/webp';
type Message = { kind: 'ok' | 'error'; text: string } | null;

async function uploadPhoto(t: Translate, productId: string, file: File, altText: string, onStep: (s: 'uploading' | 'processing') => void) {
  try {
    onStep('uploading');
    const res = await fetch(`/api/admin/products/${productId}/photos/upload-url`, { method: 'POST' });
    if (!res.ok) return { error: await errorText(t, res) };
    const { uploadId, uploadUrl } = (await res.json()) as PhotoUploadUrl;
    const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type } }).catch(() => null);
    if (!put?.ok) return { error: t('error_upload') };
    onStep('processing');
    return await send(t, `/api/admin/products/${productId}/photos`, 'POST', { uploadId, altText });
  } catch {
    return { error: t('error_generic') };
  }
}

export function PhotoManager({ product, onChange }: { product: AdminProduct; onChange: (p: AdminProduct) => void }) {
  const t = useTranslations('admin.products');
  const full = product.photos.length >= PRODUCT_LIMITS.photos;
  return (
    <section className="admin-prod-section" aria-labelledby="photos-title" data-testid="photo-manager">
      <h2 id="photos-title" className="admin-prod-section-title">
        {t('section_photos')}
      </h2>
      <p className="admin-hint admin-prod-under-legend">{t('photos_hint')}</p>
      {product.photos.length > 0 ? (
        <ol className="admin-prod-photos">
          {product.photos.map((ph, i) => (
            <PhotoCard key={ph.id} productId={product.id} photo={ph} index={i} onChange={onChange} />
          ))}
        </ol>
      ) : (
        <p className="admin-hint">{t('no_photo')}</p>
      )}
      {full ? <p className="admin-hint">{t('photo_limit')}</p> : <UploadForm productId={product.id} onChange={onChange} />}
    </section>
  );
}

function PhotoCard({ productId, photo, index, onChange }: { productId: string; photo: AdminProductPhoto; index: number; onChange: (p: AdminProduct) => void }) {
  const t = useTranslations('admin.products');
  const id = useId();
  const [alt, setAlt] = useState(photo.altText ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  useEffect(() => setAlt(photo.altText ?? ''), [photo.altText]);
  const url = `/api/admin/products/${productId}/photos/${photo.id}`;
  const missing = !photo.altText;

  async function run(method: 'PATCH' | 'DELETE', body: unknown, okText: string) {
    setBusy(true);
    setMessage(null);
    const r = await send(t, url, method, body);
    setBusy(false);
    if (r.product) {
      setMessage({ kind: 'ok', text: okText });
      onChange(r.product);
    } else setMessage({ kind: 'error', text: r.error ?? t('error_generic') });
  }

  function saveAlt(e: React.FormEvent) {
    e.preventDefault();
    if (alt.trim().length > PRODUCT_LIMITS.altText) return setMessage({ kind: 'error', text: t('error_alt') });
    void run('PATCH', { altText: alt.trim() }, t('saved'));
  }

  return (
    <li className="admin-prod-photo" data-testid="photo-card" data-missing-alt={missing || undefined}>
      <div className="admin-prod-photo-img">
        {/* The alt text shown to customers is the field below; here the image is labelled by the card heading. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {photo.url ? <img src={photo.url} alt="" width={120} height={120} loading="lazy" decoding="async" /> : null}
      </div>
      <div className="admin-prod-photo-body">
        <h3 className="admin-prod-photo-title">
          {t('photo_label', { n: index + 1 })}
          {index === 0 ? <span className="admin-prod-tag admin-prod-tag-on">{t('photo_primary')}</span> : null}
        </h3>
        <form className="admin-inline-form" onSubmit={saveAlt} noValidate>
          <div className="admin-field">
            <label htmlFor={`${id}-alt`}>{t('alt_text')}</label>
            <textarea id={`${id}-alt`} value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={PRODUCT_LIMITS.altText} rows={2} dir="auto" aria-describedby={`${id}-alt-h`} data-testid="photo-alt" />
            <p id={`${id}-alt-h`} className="admin-hint">
              {missing ? <b className="admin-prod-missing">{t('alt_missing')}. </b> : null}
              {t('alt_text_hint')}
            </p>
          </div>
          <div className="admin-inline-actions">
            <button type="submit" className="btn btn-secondary" disabled={busy} data-testid="photo-alt-save">
              {t('save_alt')}
            </button>
            {index > 0 ? (
              <button type="button" className="admin-link-button" disabled={busy} onClick={() => run('PATCH', { primary: true }, t('saved'))} data-testid="photo-primary">
                {t('make_primary')}
              </button>
            ) : null}
          </div>
        </form>
        {confirmDelete ? (
          <div className="admin-confirm" role="group" aria-labelledby={`${id}-del`}>
            <p id={`${id}-del`} className="admin-confirm-title">
              {t('delete_photo_confirm')}
            </p>
            <div className="admin-inline-actions">
              <button type="button" className="btn btn-secondary admin-danger" disabled={busy} onClick={() => run('DELETE', undefined, t('photo_deleted'))} data-testid="photo-delete-confirm">
                {t('delete_submit')}
              </button>
              <button type="button" className="admin-link-button" onClick={() => setConfirmDelete(false)}>
                {t('cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="admin-link-button admin-prod-delete-link" onClick={() => setConfirmDelete(true)} data-testid="photo-delete">
            {t('delete_photo')}
          </button>
        )}
        <p className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'} role={message?.kind === 'error' ? 'alert' : 'status'} hidden={!message} data-testid="photo-message">
          {message?.text}
        </p>
      </div>
    </li>
  );
}

function UploadForm({ productId, onChange }: { productId: string; onChange: (p: AdminProduct) => void }) {
  const t = useTranslations('admin.products');
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [alt, setAlt] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [step, setStep] = useState<'idle' | 'uploading' | 'processing'>('idle');
  const [message, setMessage] = useState<Message>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file || !ACCEPT.split(',').includes(file.type) || file.size > PRODUCT_LIMITS.photoBytes) {
      return setMessage({ kind: 'error', text: t('error_file') });
    }
    const altText = alt.trim();
    if (altText.length === 0 || altText.length > PRODUCT_LIMITS.altText) return setMessage({ kind: 'error', text: t('error_alt') });
    setMessage(null);
    const r = await uploadPhoto(t, productId, file, altText, setStep);
    setStep('idle');
    if ('product' in r && r.product) {
      setAlt('');
      if (fileRef.current) fileRef.current.value = '';
      setFileName(null);
      setMessage({ kind: 'ok', text: t('uploaded') });
      onChange(r.product);
    } else setMessage({ kind: 'error', text: r.error ?? t('error_generic') });
  }

  const busy = step !== 'idle';
  return (
    <form className="admin-prod-upload" onSubmit={submit} noValidate aria-busy={busy} aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="admin-prod-photo-title">
        {t('upload_title')}
      </h3>
      <div className="admin-field">
        <label htmlFor={`${id}-file`}>{t('upload_file')}</label>
        {/* The native control's own text follows the browser's language; this one is always Hebrew. */}
        <div className="admin-prod-filepick">
          <input
            id={`${id}-file`}
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="admin-prod-file"
            aria-describedby={`${id}-file-h`}
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
            data-testid="photo-file"
          />
          <span className="btn btn-secondary" aria-hidden="true">
            {t('choose_file')}
          </span>
          <span className="admin-prod-filename" aria-hidden="true">
            {fileName ? <bdi>{fileName}</bdi> : t('no_file')}
          </span>
        </div>
        <p id={`${id}-file-h`} className="admin-hint">
          {t('upload_file_hint')}
        </p>
      </div>
      <div className="admin-field">
        <label htmlFor={`${id}-alt`}>{t('alt_text')}</label>
        <textarea id={`${id}-alt`} value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={PRODUCT_LIMITS.altText} rows={2} dir="auto" aria-describedby={`${id}-alt-h`} data-testid="photo-new-alt" />
        <p id={`${id}-alt-h`} className="admin-hint">
          {t('alt_text_hint')}
        </p>
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy} data-testid="photo-upload">
        {step === 'uploading' ? t('uploading') : step === 'processing' ? t('processing') : t('upload_submit')}
      </button>
      <p className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'} role={message?.kind === 'error' ? 'alert' : 'status'} hidden={!message} data-testid="upload-message">
        {message?.text}
      </p>
    </form>
  );
}
