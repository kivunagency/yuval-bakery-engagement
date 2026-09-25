import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import he from '@/messages/he.json';

type Tree = { [k: string]: string | Tree };
const keys = (t: Tree, prefix = ''): string[] =>
  Object.entries(t).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`)));

describe('messages', () => {
  it('he.json has exactly the keys of en.json (en is primary)', () => {
    expect(keys(he as Tree).sort()).toEqual(keys(en as Tree).sort());
  });
  it('no em-dash or en-dash in any message', () => {
    const all = JSON.stringify(en) + JSON.stringify(he);
    expect(all).not.toMatch(/[\u2013\u2014]/);
  });
  it('Hebrew messages use Hebrew geresh/gershayim, not Latin quotes inside words', () => {
    const bad = keys(he as Tree).filter((k) => {
      const v = k.split('.').reduce<Tree | string>((t, p) => (t as Tree)[p]!, he as Tree) as string;
      return /[א-ת]["'][א-ת]/.test(v);
    });
    expect(bad).toEqual([]);
  });
});
