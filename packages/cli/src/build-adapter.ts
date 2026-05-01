// CLI projection of the command registry.
//
// Companion to `@psraghuveer/memento-server`'s `buildMementoServer`. Same
// shape, same contract, different surface marker:
//
//   - filters the registry to commands whose `surfaces` includes
//     `'cli'`,
//   - exposes a single `run(name, rawInput)` entry point that
//     marshalls everything through `executeCommand` so that
//     input/output validation behave identically to MCP,
//   - returns the structured `Result<unknown>` verbatim — argv
//     parsing and human-readable rendering live in the eventual
//     `cli.ts` UX layer (still a scaffold), not here.
//
// Keeping argv/IO out of this file is deliberate (ADR 0003): the
// adapter is the contract slot. The parity test
// (`./parity.contract.test.ts`) pins that, for every registered
// command, the union of adapters that expose it equals the
// command's declared `surfaces` set. Drift in either direction
// fails the build.

import type { AnyCommand, CommandContext, CommandRegistry } from '@psraghuveer/memento-core';
import { executeCommand } from '@psraghuveer/memento-core';
import { type MementoError, type Result, err } from '@psraghuveer/memento-schema';

/**
 * Inputs for `buildCliAdapter`.
 *
 * Mirrors `BuildMementoServerOptions`. The `actor` is pinned at
 * construction time for the same reason as on the MCP side: the
 * audit log demands one for every write, and asking each call
 * site to thread it through would invert the dependency.
 */
export interface BuildCliAdapterOptions {
  readonly registry: CommandRegistry;
  readonly ctx: CommandContext;
}

/**
 * The minimal programmatic surface the CLI exposes.
 *
 * `names` is the sorted list of commands available on this
 * surface — used by the (future) argv layer to render usage and
 * by the parity contract test to assert exposure.
 *
 * `run` validates the input via the command's Zod schema, runs
 * the handler, validates the output, and returns the resulting
 * `Result`. Unknown command names produce an `INVALID_INPUT`
 * `Result.err` rather than throwing — caller mistakes are not
 * exceptions.
 */
export interface CliAdapter {
  readonly names: readonly string[];
  run(name: string, rawInput: unknown): Promise<Result<unknown>>;
}

/**
 * Surface marker for the CLI projection. Centralised so a typo
 * in one place cannot silently desync from the registry.
 */
const SURFACE = 'cli' as const;

/**
 * Build the CLI adapter from a populated command registry.
 *
 * The returned object holds no I/O resources; it is safe to
 * construct multiple adapters over the same registry (e.g. one
 * per test) without coordination.
 */
export function buildCliAdapter(options: BuildCliAdapterOptions): CliAdapter {
  const { registry, ctx } = options;

  const cliCommands = registry.list().filter((cmd: AnyCommand) => cmd.surfaces.includes(SURFACE));
  const byName = new Map<string, AnyCommand>(cliCommands.map((cmd: AnyCommand) => [cmd.name, cmd]));
  const names: readonly string[] = [...byName.keys()].sort();

  return {
    names,
    async run(name, rawInput) {
      const command = byName.get(name);
      if (command === undefined) {
        return err<MementoError>({
          code: 'INVALID_INPUT',
          message: `Unknown command '${name}'`,
        });
      }
      return executeCommand(command, rawInput, ctx);
    },
  };
}
