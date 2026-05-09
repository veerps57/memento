// Shared types for the `pack create` lifecycle command and its
// review prompter. Lives in its own module so the prompter
// implementation does not need to import from `pack.ts` (which
// would create a cycle once `pack.ts` imports the prompter).

export interface ReviewMemoryItem {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly tags: readonly string[];
}
