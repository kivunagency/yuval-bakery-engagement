// Reads apps/web/.env.local written by scripts/local-stack/up.sh.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function localEnv() {
  const text = readFileSync(join(__dirname, '..', '..', '.env.local'), 'utf8');
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

module.exports = { localEnv };
