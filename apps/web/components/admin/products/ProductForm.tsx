'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Switch } from '@/components/admin/capacity/Switch';
import { ALLERGEN_CODES, isKnownAllergen } from '@/lib/shared/catalog/allergens';
import {
  PRODUCT_LIMITS,
  productMinutes,
  productPrice,
  publishBlockers,
  type AdminProduct,
  type CostBasis,
  type ProductCreate,
} from '@/lib/shared/contracts/admin-products';
import { send } from '@/components/admin/products/api';

// Create and edit form of one product (client-006, US-12, design-tokens.md
// "שדות וטפסים"): label above, hint below, error below the hint. Saving sends
// every field; the DB audits only what changed. Publishing is refused by the
// DB while the allergens are not confirmed or a photo has no alt text; the
// form says why before she tries. Photos are managed next to it (PhotoManager).

type Draft = {
  name: string;
  description: string;
  price: string;
  costBasis: CostBasis;
  ovenMinutes: string;
  workMinutes: string;
  ingredients: string;
  contains: string[];
  containsOther: string;
  mayContain: string[];
  mayContainOther: string;
  allergenNotes: string;
  allergensConfirmed: boolean;
  isAvailable: boolean;
  isPublished: boolean;
};

const splitOther = (s: string) =>
  s
    .split(/[,،]/)
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

function toDraft(p: AdminProduct | null): Draft {
  return {
    name: p?.name ?? '',
    description: p?.description ?? '',
    price: p ? String(p.price) : '',
    costBasis: p?.costBasis ?? 'per_unit',
    ovenMinutes: p ? String(p.ovenMinutes) : '',
    workMinutes: p ? String(p.workMinutes) : '',
    ingredients: p?.ingredients ?? '',
    contains: (p?.allergens ?? []).filter(isKnownAllergen),
    containsOther: (p?.allergens ?? []).filter((a) => !isKnownAllergen(a)).join(', '),
    mayContain: (p?.mayContain ?? []).filter(isKnownAllergen),
    mayContainOther: (p?.mayContain ?? []).filter((a) => !isKnownAllergen(a)).join(', '),
    allergenNotes: p?.allergenNotes ?? '',
    allergensConfirmed: p?.allergensConfirmed ?? false,
    isAvailable: p?.isAvailable ?? true,
    isPublished: p?.isPublished ?? false,
  };
}

type FieldError = 'name' | 'price' | 'minutes' | null;

/** The request body, or which field is wrong. The server and the DB validate again. */
function toBody(d: Draft): { body: ProductCreate } | { error: Exclude<FieldError, null> } {
  const name = d.name.trim();
  if (name.length === 0 || name.length > PRODUCT_LIMITS.name) return { error: 'name' };
  const price = productPrice.safeParse(d.price.trim() === '' ? NaN : Number(d.price.trim()));
  if (!price.success) return { error: 'price' };
  const oven = productMinutes.safeParse(/^\d+$/.test(d.ovenMinutes.trim()) ? Number(d.ovenMinutes.trim()) : NaN);
  const work = productMinutes.safeParse(/^\d+$/.test(d.workMinutes.trim()) ? Number(d.workMinutes.trim()) : NaN);
  if (!oven.success || !work.success) return { error: 'minutes' };
  return {
    body: {
      name,
      description: d.description.trim() || null,
      price: price.data,
      costBasis: d.costBasis,
      ovenMinutes: oven.data,
      workMinutes: work.data,
      ingredients: d.ingredients.trim() || null,
      allergens: [...d.contains, ...splitOther(d.containsOther)],
      mayContain: [...d.mayContain, ...splitOther(d.mayContainOther)],
      allergenNotes: d.allergenNotes.trim() || null,
      allergensConfirmed: d.allergensConfirmed,
      isAvailable: d.isAvailable,
      isPublished: d.isPublished,
    },
  };
}

export function ProductForm({
  product,
  onSaved,
}: {
  /** null: a new product. */
  product: AdminProduct | null;
  onSaved: (p: AdminProduct, created: boolean) => void;
}) {
  const t = useTranslations('admin.products');
  const tAllergen = useTranslations('catalog.allergen');
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => toDraft(product));
  const [fieldError, setFieldError] = useState<FieldError>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [allergensReset, setAllergensReset] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  /** An allergen edit un-ticks the confirmation, like the DB does. */
  const setAllergen = <K extends 'ingredients' | 'contains' | 'containsOther' | 'mayContain' | 'mayContainOther' | 'allergenNotes'>(key: K, value: Draft[K]) => {
    if (draft.allergensConfirmed) setAllergensReset(true);
    setDraft((d) => ({ ...d, [key]: value, allergensConfirmed: false }));
  };
  const toggleCode = (list: 'contains' | 'mayContain', code: string) =>
    setAllergen(list, draft[list].includes(code) ? draft[list].filter((c) => c !== code) : [...draft[list], code]);

  const blockers = publishBlockers({ allergensConfirmed: draft.allergensConfirmed, photos: product?.photos ?? [] });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = toBody(draft);
    if ('error' in parsed) {
      setFieldError(parsed.error);
      setMessage(null);
      return;
    }
    setFieldError(null);
    setBusy(true);
    setMessage(null);
    const r = product
      ? await send(t, `/api/admin/products/${product.id}`, 'PATCH', parsed.body)
      : await send(t, '/api/admin/products', 'POST', parsed.body);
    setBusy(false);
    if (r.product) {
      setDraft(toDraft(r.product));
      setAllergensReset(false);
      setMessage({ kind: 'ok', text: product ? t('saved') : t('created') });
      onSaved(r.product, !product);
    } else {
      setMessage({ kind: 'error', text: r.error ?? t('error_generic') });
    }
  }

  const fieldErrorText = (f: Exclude<FieldError, null>) =>
    fieldError === f ? (
      <p className="admin-form-error admin-field-error" role="alert" data-testid={`error-${f}`}>
        {t(f === 'name' ? 'error_name' : f === 'price' ? 'error_price' : 'error_minutes')}
      </p>
    ) : null;

  const codeChips = (list: 'contains' | 'mayContain', label: string) => (
    <fieldset className="admin-prod-fieldset">
      <legend>{label}</legend>
      <div className="admin-prod-codes">
        {ALLERGEN_CODES.map((code) => (
          <label key={code} className="admin-prod-code" data-dashed={list === 'mayContain' || undefined}>
            <input type="checkbox" checked={draft[list].includes(code)} onChange={() => toggleCode(list, code)} data-testid={`${list}-${code}`} />
            <span>{tAllergen(code)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <form className="admin-prod-form" onSubmit={save} noValidate aria-busy={busy} data-testid="product-form">
      <section className="admin-prod-section" aria-labelledby={`${id}-s1`}>
        <h2 id={`${id}-s1`} className="admin-prod-section-title">
          {t('section_details')}
        </h2>
        <div className="admin-field">
          <label htmlFor={`${id}-name`}>{t('name')}</label>
          <input id={`${id}-name`} value={draft.name} onChange={(e) => set('name', e.target.value)} dir="auto" maxLength={PRODUCT_LIMITS.name} required aria-invalid={fieldError === 'name' || undefined} data-testid="product-name" />
          {fieldErrorText('name')}
        </div>
        <div className="admin-field">
          <label htmlFor={`${id}-desc`}>{t('description')}</label>
          <textarea id={`${id}-desc`} value={draft.description} onChange={(e) => set('description', e.target.value)} maxLength={PRODUCT_LIMITS.description} rows={3} aria-describedby={`${id}-desc-h`} data-testid="product-description" />
          <p id={`${id}-desc-h`} className="admin-hint">
            {t('description_hint')}
          </p>
        </div>
      </section>

      <section className="admin-prod-section" aria-labelledby={`${id}-s2`}>
        <h2 id={`${id}-s2`} className="admin-prod-section-title">
          {t('section_price')}
        </h2>
        <p className="admin-note admin-prod-snapshot" data-testid="snapshot-note">
          {t('snapshot_note')}
        </p>
        <div className="admin-field">
          <label htmlFor={`${id}-price`}>{t('price')}</label>
          <span className="admin-prod-money">
            <input id={`${id}-price`} inputMode="decimal" dir="ltr" className="num" value={draft.price} onChange={(e) => set('price', e.target.value)} aria-describedby={`${id}-price-h`} aria-invalid={fieldError === 'price' || undefined} data-testid="product-price" />
            <span aria-hidden="true">₪</span>
          </span>
          <p id={`${id}-price-h`} className="admin-hint">
            {t('price_hint')}
          </p>
          {fieldErrorText('price')}
        </div>
        <fieldset className="admin-prod-fieldset">
          <legend>{t('cost_basis')}</legend>
          <div className="admin-prod-radios">
            {(['per_unit', 'per_batch'] as const).map((b) => (
              <label key={b} className="admin-prod-radio">
                <input type="radio" name={`${id}-basis`} value={b} checked={draft.costBasis === b} onChange={() => set('costBasis', b)} data-testid={`basis-${b}`} />
                <span>{t(b === 'per_unit' ? 'cost_basis_per_unit' : 'cost_basis_per_batch')}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="admin-edit-row">
          <div className="admin-field">
            <label htmlFor={`${id}-oven`}>{t('oven_minutes')}</label>
            <input id={`${id}-oven`} inputMode="numeric" dir="ltr" className="num" value={draft.ovenMinutes} onChange={(e) => set('ovenMinutes', e.target.value)} aria-describedby={`${id}-min-h`} aria-invalid={fieldError === 'minutes' || undefined} data-testid="product-oven" />
          </div>
          <div className="admin-field">
            <label htmlFor={`${id}-work`}>{t('work_minutes')}</label>
            <input id={`${id}-work`} inputMode="numeric" dir="ltr" className="num" value={draft.workMinutes} onChange={(e) => set('workMinutes', e.target.value)} aria-describedby={`${id}-min-h`} aria-invalid={fieldError === 'minutes' || undefined} data-testid="product-work" />
          </div>
        </div>
        <p id={`${id}-min-h`} className="admin-hint">
          {t('minutes_hint')}
        </p>
        {fieldErrorText('minutes')}
      </section>

      <section className="admin-prod-section" aria-labelledby={`${id}-s3`}>
        <h2 id={`${id}-s3`} className="admin-prod-section-title">
          {t('section_allergens')}
        </h2>
        <div className="admin-field">
          <label htmlFor={`${id}-ingr`}>{t('ingredients')}</label>
          <textarea id={`${id}-ingr`} value={draft.ingredients} onChange={(e) => setAllergen('ingredients', e.target.value)} maxLength={PRODUCT_LIMITS.ingredients} rows={3} data-testid="product-ingredients" />
        </div>
        {codeChips('contains', t('contains'))}
        <div className="admin-field">
          <label htmlFor={`${id}-c-other`}>{t('other_allergens')}</label>
          <input id={`${id}-c-other`} value={draft.containsOther} onChange={(e) => setAllergen('containsOther', e.target.value)} maxLength={400} aria-describedby={`${id}-other-h`} data-testid="product-contains-other" />
          <p id={`${id}-other-h`} className="admin-hint">
            {t('other_allergens_hint')}
          </p>
        </div>
        {codeChips('mayContain', t('may_contain'))}
        <p className="admin-hint admin-prod-under-legend">{t('may_contain_hint')}</p>
        <div className="admin-field">
          <label htmlFor={`${id}-m-other`}>{t('other_allergens')}</label>
          <input id={`${id}-m-other`} value={draft.mayContainOther} onChange={(e) => setAllergen('mayContainOther', e.target.value)} maxLength={400} aria-describedby={`${id}-other-h`} data-testid="product-may-contain-other" />
        </div>
        <div className="admin-field">
          <label htmlFor={`${id}-notes`}>{t('allergen_notes')}</label>
          <textarea id={`${id}-notes`} value={draft.allergenNotes} onChange={(e) => setAllergen('allergenNotes', e.target.value)} maxLength={PRODUCT_LIMITS.allergenNotes} rows={2} data-testid="product-allergen-notes" />
        </div>
        <label className="admin-prod-check">
          <input type="checkbox" checked={draft.allergensConfirmed} onChange={(e) => { set('allergensConfirmed', e.target.checked); setAllergensReset(false); }} aria-describedby={`${id}-conf-h`} data-testid="product-allergens-confirmed" />
          <span>{t('allergens_confirmed')}</span>
        </label>
        <p id={`${id}-conf-h`} className="admin-hint">
          {t('allergens_confirmed_hint')}
        </p>
        {allergensReset ? (
          <p className="admin-warn" role="status" data-testid="allergens-reset">
            {t('allergens_reset')}
          </p>
        ) : null}
      </section>

      <section className="admin-prod-section" aria-labelledby={`${id}-s4`}>
        <h2 id={`${id}-s4`} className="admin-prod-section-title">
          {t('section_visibility')}
        </h2>
        <div className="admin-toggle-row">
          <span id={`${id}-avail`}>{t('availability_toggle')}</span>
          <Switch checked={draft.isAvailable} onChange={(v) => set('isAvailable', v)} labelledBy={`${id}-avail`} testId="form-available" />
        </div>
        <p className="admin-hint">{t('availability_hint')}</p>
        <div className="admin-toggle-row">
          <span id={`${id}-pub`}>{t('published_toggle')}</span>
          <Switch checked={draft.isPublished} onChange={(v) => set('isPublished', v)} labelledBy={`${id}-pub`} testId="form-published" />
        </div>
        {blockers.length > 0 ? (
          <div className="admin-hint" data-testid="publish-blockers">
            <p className="admin-prod-blockers-title">{t('blockers_title')}</p>
            <ul className="admin-prod-blockers">
              {blockers.map((b) => (
                <li key={b}>{t(`blocker_${b}`)}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <button type="submit" className="btn btn-primary admin-submit" disabled={busy} data-testid="product-save">
        {busy ? t('saving') : product ? t('save') : t('create')}
      </button>
      <p className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'} role={message?.kind === 'error' ? 'alert' : 'status'} hidden={!message} data-testid="product-message">
        {message?.text}
      </p>
    </form>
  );
}
