// Reads the mails Supabase Auth sent through the local stack's SMTP sink
// (scripts/local-stack/smtp-sink.mjs writes .local-stack/mail/*.eml).
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const MAIL_DIR = join(__dirname, '..', '..', '.local-stack', 'mail');

function decodeQuotedPrintable(text) {
  const bytes = [];
  const soft = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === '=' && /^[0-9A-F]{2}$/i.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(soft[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Every mail sent to `to`, oldest first: { file, headers, body }. */
function mailsTo(to) {
  if (!existsSync(MAIL_DIR)) return [];
  return readdirSync(MAIL_DIR)
    .sort()
    .map((file) => ({ file, raw: readFileSync(join(MAIL_DIR, file), 'utf8') }))
    .filter(({ raw }) => raw.split('\r\n', 1)[0].toLowerCase().split(/[:,]\s*/).includes(to.toLowerCase()))
    .map(({ file, raw }) => {
      const split = raw.indexOf('\r\n\r\n');
      const headers = raw.slice(0, split);
      const rawBody = raw.slice(split + 4);
      const body = /Content-Transfer-Encoding:\s*quoted-printable/i.test(headers) ? decodeQuotedPrintable(rawBody) : rawBody;
      return { file, headers, body };
    });
}

/** Waits for the n-th mail to `to` (1-based) and returns it. */
async function waitForMail(to, n = 1, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const all = mailsTo(to);
    if (all.length >= n) return all[n - 1];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail #${n} to ${to} within ${timeoutMs}ms`);
}

/** The /account/confirm path+query from a confirmation mail (host dropped: tests use their own baseURL). */
function confirmPathFrom(mail) {
  const m = /href="([^"]*\/account\/confirm\?[^"]*)"/.exec(mail.body);
  if (!m) throw new Error('no confirmation link in mail');
  const url = new URL(m[1].replace(/&amp;/g, '&'));
  return url.pathname + url.search;
}

module.exports = { mailsTo, waitForMail, confirmPathFrom };
