import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: ['.next/**', 'node_modules/**', '.local-stack/**', 'next-env.d.ts', 'qa/**', 'scripts/**'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // SEC-025: user text (inscriptions, notes) is rendered by React escaping only.
      'react/no-danger': 'error',
      // Hebrew never lives in code (English-first i18n). Strings go to messages/he.json.
      'no-restricted-syntax': [
        'error',
        { selector: 'Literal[value=/[\\u0590-\\u05FF]/]', message: 'No Hebrew literals in code: add an English key to messages/en.json and the Hebrew to messages/he.json.' },
        { selector: 'JSXText[value=/[\\u0590-\\u05FF]/]', message: 'No Hebrew literals in code: add an English key to messages/en.json and the Hebrew to messages/he.json.' },
        { selector: 'TemplateElement[value.raw=/[\\u0590-\\u05FF]/]', message: 'No Hebrew literals in code: add an English key to messages/en.json and the Hebrew to messages/he.json.' },
      ],
    },
  },
  {
    // Client code must never reach server-only modules or secrets.
    files: ['components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/lib/server/*', '**/lib/server/*'], message: 'Client components cannot import lib/server (DB and secrets are server-only).' }] }],
    },
  },
];

export default config;
