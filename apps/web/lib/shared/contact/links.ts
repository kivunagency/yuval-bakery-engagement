// Tap-to-call and WhatsApp links for the contact block (US-0b). Pure, no I/O.
// Input is whatever Yuval typed in settings; anything that is not a valid
// Israeli number yields null, and the UI shows a placeholder instead of a
// link to a wrong number.

/** Israeli number without country code and leading 0: mobile/VoIP 9 digits, landline 8. */
function toLocalDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[\s\-().]/g, '');
  const local = s.startsWith('+972') ? s.slice(4) : s.startsWith('972') ? s.slice(3) : s.startsWith('0') ? s.slice(1) : null;
  if (local === null) return null;
  return /^(?:[57]\d{8}|[23489]\d{7})$/.test(local) ? local : null;
}

/** +972XXXXXXXXX, or null. */
export function toE164(raw: string | null | undefined): string | null {
  const local = toLocalDigits(raw);
  return local ? `+972${local}` : null;
}

export function telHref(raw: string | null | undefined): string | null {
  const e164 = toE164(raw);
  return e164 ? `tel:${e164}` : null;
}

/** https://wa.me/972XXXXXXXXX with an optional prefilled message. */
export function waMeHref(raw: string | null | undefined, text?: string): string | null {
  const local = toLocalDigits(raw);
  if (!local) return null;
  const base = `https://wa.me/972${local}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

/** Local display form: 050-123-4567 (mobile) or 03-123-4567 (landline). Render inside an LTR isolate. */
export function displayPhone(raw: string | null | undefined): string | null {
  const local = toLocalDigits(raw);
  if (!local) return null;
  const d = `0${local}`;
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
}
