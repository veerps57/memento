import { describe, expect, it } from 'vitest';

// Smoke test for the @psraghuveer/memento-schema package. The real schemas land
// in subsequent commits; this file exists to prove the test runner
// is wired correctly and that the package is reachable from vitest.
describe('@psraghuveer/memento-schema', () => {
  it('package is importable', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeDefined();
  });
});
