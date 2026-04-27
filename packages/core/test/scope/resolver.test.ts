import type { Scope } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import {
  type ActiveScopes,
  effectiveScopes,
  resolveEffectiveScopes,
  scopeKey,
} from '../../src/scope/resolver.js';

const global: Extract<Scope, { type: 'global' }> = { type: 'global' };
const workspace = {
  type: 'workspace',
  path: '/Users/me/proj' as never,
} as Extract<Scope, { type: 'workspace' }>;
const repo = {
  type: 'repo',
  remote: 'github.com/org/proj' as never,
} as Extract<Scope, { type: 'repo' }>;
const branch = {
  type: 'branch',
  remote: 'github.com/org/proj' as never,
  branch: 'feat/x',
} as Extract<Scope, { type: 'branch' }>;
const session = {
  type: 'session',
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' as never,
} as Extract<Scope, { type: 'session' }>;

const fullActive: ActiveScopes = {
  session,
  branch,
  repo,
  workspace,
  global,
};

describe('effectiveScopes', () => {
  it('emits all five tiers in most-specific → least-specific order', () => {
    expect(effectiveScopes(fullActive).map((s) => s.type)).toEqual([
      'session',
      'branch',
      'repo',
      'workspace',
      'global',
    ]);
  });

  it('skips null tiers (no git remote, no live session)', () => {
    const active: ActiveScopes = {
      session: null,
      branch: null,
      repo: null,
      workspace,
      global,
    };
    expect(effectiveScopes(active).map((s) => s.type)).toEqual(['workspace', 'global']);
  });

  it('always includes workspace + global (the always-resolvable tiers)', () => {
    const active: ActiveScopes = {
      session: null,
      branch: null,
      repo: null,
      workspace,
      global,
    };
    const out = effectiveScopes(active);
    expect(out).toContainEqual(workspace);
    expect(out).toContainEqual(global);
  });

  it('drops only branch when on a detached head with a remote', () => {
    const active: ActiveScopes = {
      session,
      branch: null,
      repo,
      workspace,
      global,
    };
    expect(effectiveScopes(active).map((s) => s.type)).toEqual([
      'session',
      'repo',
      'workspace',
      'global',
    ]);
  });
});

describe('resolveEffectiveScopes', () => {
  it("'effective' returns the layered set", () => {
    expect(resolveEffectiveScopes('effective', fullActive)).toEqual(effectiveScopes(fullActive));
  });

  it("'all' is currently equivalent to 'effective'", () => {
    expect(resolveEffectiveScopes('all', fullActive)).toEqual(effectiveScopes(fullActive));
  });

  it('an explicit scope list is returned in caller order', () => {
    const filter = [global, repo, workspace] as const;
    expect(resolveEffectiveScopes(filter, fullActive)).toEqual([global, repo, workspace]);
  });

  it('an explicit scope list dedupes by structural key', () => {
    const dupRepo: Extract<Scope, { type: 'repo' }> = {
      type: 'repo',
      remote: 'github.com/org/proj' as never,
    };
    const filter = [repo, dupRepo, global, global] as const;
    expect(resolveEffectiveScopes(filter, fullActive)).toEqual([repo, global]);
  });

  it('an empty explicit list returns an empty array (no fallback)', () => {
    expect(resolveEffectiveScopes([], fullActive)).toEqual([]);
  });
});

describe('scopeKey', () => {
  it('produces stable, structurally-keyed strings per variant', () => {
    expect(scopeKey(global)).toBe('global');
    expect(scopeKey(workspace)).toBe('workspace:/Users/me/proj');
    expect(scopeKey(repo)).toBe('repo:github.com/org/proj');
    expect(scopeKey(branch)).toBe('branch:github.com/org/proj@feat/x');
    expect(scopeKey(session)).toBe('session:01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('distinguishes branches on the same remote', () => {
    const a = scopeKey({ ...branch, branch: 'main' });
    const b = scopeKey({ ...branch, branch: 'feat/x' });
    expect(a).not.toBe(b);
  });
});
