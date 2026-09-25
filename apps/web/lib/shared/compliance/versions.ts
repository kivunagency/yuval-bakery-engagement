// Versions of the legal texts this build renders. The text itself lives in
// messages/he.json; the version names that exact text. A page shows the
// version it renders, and an order records the version the customer saw, so
// checkout passes these constants (not a DB value) to the order functions.
// app_settings.active_*_version must equal these: the regression suite
// (qa/regression.compliance.spec.js) fails if the DB and the code disagree.
// Changing a text materially = bump its version here AND in app_settings
// (new migration) in the same PR.
export const TEXT_VERSIONS = {
  privacy: 'privacy-2026-10-v1',
  terms: 'terms-2026-10-v1',
  cancellation: 'cancellation-2026-10-v1',
} as const;
export type TextVersionKey = keyof typeof TEXT_VERSIONS;

// Date the accessibility statement was last reviewed (Rule 33 item 9: the
// statement carries its update date). Change it whenever the text or the
// site's accessibility status changes.
export const ACCESSIBILITY_STATEMENT_UPDATED = '2026-09-25';
