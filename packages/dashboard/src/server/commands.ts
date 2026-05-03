// Generic command-router middleware.
//
// Why a generic router
// --------------------
//
// The dashboard's HTTP API is essentially "expose the registry
// over HTTP" — every UI feature maps to a registered command, and
// the registry is the single source of truth for what's callable
// (ADR-0003). A generic POST `/api/commands/:name` endpoint lets
// the dashboard call any registered command without per-command
// route boilerplate. New commands the registry adds surface
// automatically *if* the registration explicitly opts onto the
// dashboard surface.
//
// The route is a thin wrapper over `executeCommand(...)` from
// `@psraghuveer/memento-core`, so input validation, output
// validation, and `Result` semantics flow through unchanged. The
// HTTP serialization is the only addition.
//
// Surface gate. Only commands whose `surfaces` array includes
// `'dashboard'` are admitted. Anything else returns
// `INVALID_INPUT` with a clear hint pointing the caller at the
// CLI alternative. The split is structural, not aspirational —
// new commands default to mcp+cli-only and adding them to the
// dashboard surface is an explicit decision visible in the
// registration site's diff.

import type { AnyCommand, CommandContext, CommandRegistry } from '@psraghuveer/memento-core';
import { executeCommand } from '@psraghuveer/memento-core';
import { Hono } from 'hono';

export interface CommandRouterDeps {
  readonly registry: CommandRegistry;
  /** Actor recorded on every audit event the command emits. */
  readonly ctx: CommandContext;
}

const DASHBOARD_SURFACE = 'dashboard';

function isDashboardSurfaced(cmd: AnyCommand): boolean {
  return cmd.surfaces.includes(DASHBOARD_SURFACE);
}

/**
 * Build the `/api/commands/*` sub-app. Mounted by
 * {@link createDashboardServer}.
 *
 * Routes:
 *   - GET  /                  list every dashboard-surfaced command
 *                             (name, sideEffect, description) for
 *                             client-side discovery / the command
 *                             palette. Commands not on the dashboard
 *                             surface are omitted.
 *   - POST /:name             execute the named command with the
 *                             POST body as input. Rejects commands
 *                             not on the dashboard surface with a
 *                             clear `INVALID_INPUT`.
 */
export function createCommandRouter(deps: CommandRouterDeps): Hono {
  const router = new Hono();
  const byName = new Map<string, AnyCommand>(
    deps.registry
      .list()
      .filter(isDashboardSurfaced)
      .map((cmd) => [cmd.name, cmd]),
  );

  router.get('/', (c) =>
    c.json({
      ok: true,
      value: deps.registry
        .list()
        .filter(isDashboardSurfaced)
        .map((cmd) => ({
          name: cmd.name,
          sideEffect: cmd.sideEffect,
          surfaces: cmd.surfaces,
          description: cmd.metadata.description,
          ...(cmd.metadata.deprecated !== undefined ? { deprecated: cmd.metadata.deprecated } : {}),
        })),
    }),
  );

  router.post('/:name', async (c) => {
    const name = c.req.param('name');
    const command = byName.get(name);
    if (command === undefined) {
      // Distinguish "command exists but not on dashboard surface"
      // from "command does not exist at all" so the failure mode
      // is actionable: the operator sees they should use the CLI.
      const allCommand = deps.registry.list().find((cmd) => cmd.name === name);
      if (allCommand !== undefined) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'INVALID_INPUT',
              message: `Command '${name}' is not exposed on the dashboard surface. Use the CLI ('npx memento ...') or MCP if you need it.`,
            },
          },
          400,
        );
      }
      return c.json(
        {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: `Unknown command '${name}'.`,
          },
        },
        404,
      );
    }
    let input: unknown = {};
    try {
      const text = await c.req.text();
      input = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      return c.json(
        {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Request body is not valid JSON.',
          },
        },
        400,
      );
    }
    const result = await executeCommand(command, input, deps.ctx);
    // `executeCommand` returns a `Result<T>` envelope; we serialize
    // it verbatim. HTTP status follows: 200 on success, 400/500 on
    // failure based on the error code.
    if (result.ok) {
      return c.json(result, 200);
    }
    const status = httpStatusForError(result.error.code);
    return c.json(result, status);
  });

  return router;
}

/**
 * Map error codes to HTTP statuses. Conservative: most errors are
 * 400 (caller's fault), `STORAGE_ERROR` and `INTERNAL` are 500.
 * The error envelope itself always carries the structured
 * `Result.err` shape, so the client never has to parse the status
 * — but it's nice for HTTP-layer tooling.
 *
 * Exported so the mapping can be tested directly without
 * synthesising every error branch through real `executeCommand`
 * calls — synthesising a `STORAGE_ERROR` requires a corrupt DB,
 * an `EMBEDDER_ERROR` requires a broken provider, etc. The pure
 * mapper is simpler to pin than the side-effects that produce
 * each code.
 */
export function httpStatusForError(code: string): 400 | 404 | 409 | 500 {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'STORAGE_ERROR':
    case 'EMBEDDER_ERROR':
    case 'INTERNAL':
      return 500;
    default:
      // INVALID_INPUT, IMMUTABLE, CONFIG_ERROR, SCRUBBED, anything
      // else added later — caller's fault.
      return 400;
  }
}
