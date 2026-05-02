// Unit tests for `src/ui/lib/cn.ts`.
//
// `cn` is a one-liner around `clsx` + `tailwind-merge` (the
// shadcn pattern). The function itself is trivial; the tests
// pin the contract so a future replacement of `tailwind-merge`
// does not silently regress conflict resolution.

import { describe, expect, it } from 'vitest';

import { cn } from '../src/ui/lib/cn.js';

describe('cn', () => {
  it('joins class strings with a single space', () => {
    expect(cn('p-2', 'm-1')).toBe('p-2 m-1');
  });

  it('drops false / null / undefined entries (clsx semantics)', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });

  it('resolves Tailwind utility conflicts (tailwind-merge semantics)', () => {
    // Without tailwind-merge, both classes would land in the DOM
    // and the cascade picks one in undefined order. With it, the
    // later class wins deterministically.
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-fg', 'text-accent')).toBe('text-accent');
  });

  it('honours conditional class objects', () => {
    expect(cn('base', { active: true, disabled: false })).toBe('base active');
  });
});
