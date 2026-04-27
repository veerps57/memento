// Command registry container.
//
// The registry is an in-memory, frozen-after-build map from
// command name to `AnyCommand`. The construction pattern is:
//
//     const registry = createRegistry()
//       .register(memoryWrite)
//       .register(memoryRead)
//       /* … */
//       .freeze();
//
//     adapter.bind(registry);                // mcp / cli
//     executeCommand(registry.get('memory.write'), input, ctx);
//
// Why a builder + freeze:
//
// - Commands are static at process start. Adapters bind once,
//   then iterate. A frozen registry is a guarantee against
//   mid-run mutation, which would silently de-sync the MCP and
//   CLI surfaces.
// - Duplicate names are a build-time error, not a runtime
//   warning: a parity contract over duplicates is meaningless.
// - The registry is generic-erased (it stores `AnyCommand`).
//   Type recovery happens at the call site through
//   `executeCommand`, which is the one place that knows the
//   precise generics.

import type { AnyCommand } from './types.js';

/**
 * The frozen registry surface. Iteration order matches
 * registration order — adapters that render help text or tool
 * lists rely on it for stable output.
 */
export interface CommandRegistry {
  /** Look up a command by name. Returns `undefined` for unknown names. */
  get(name: string): AnyCommand | undefined;
  /** All registered commands, in registration order. */
  list(): readonly AnyCommand[];
  /** `true` iff a command with that name is registered. */
  has(name: string): boolean;
}

/**
 * The pre-freeze builder. `register` returns the same builder
 * for chaining; `freeze` returns the read-only `CommandRegistry`.
 *
 * `register` validates two things up-front:
 *
 * - Names are unique. A second registration with the same name
 *   throws — silently overwriting would lose a command from
 *   one adapter and not the other.
 * - At least one surface is declared. A command nobody can
 *   call is dead code; reject it at build time.
 */
export interface CommandRegistryBuilder {
  register(command: AnyCommand): CommandRegistryBuilder;
  freeze(): CommandRegistry;
}

export function createRegistry(): CommandRegistryBuilder {
  const byName = new Map<string, AnyCommand>();
  const order: AnyCommand[] = [];

  const builder: CommandRegistryBuilder = {
    register(command) {
      if (byName.has(command.name)) {
        throw new Error(`Command '${command.name}' is already registered; names must be unique`);
      }
      if (command.surfaces.length === 0) {
        throw new Error(
          `Command '${command.name}' declares no surfaces; at least one of 'mcp' | 'cli' is required`,
        );
      }
      byName.set(command.name, command);
      order.push(command);
      return builder;
    },
    freeze() {
      const frozenOrder = Object.freeze([...order]) as readonly AnyCommand[];
      return {
        get(name) {
          return byName.get(name);
        },
        list() {
          return frozenOrder;
        },
        has(name) {
          return byName.has(name);
        },
      };
    },
  };
  return builder;
}
