---
'@psraghuveer/memento': patch
---

docs+walkthrough: align Quickstart prose with the 0.9.0 four-prompt init flow

Two surfaces visible to end users were still describing `memento init` as a three-prompt walkthrough after 0.9.0 added the persona auto-install prompt as the fourth one-keystroke question:

- **Package README.** `packages/cli/README.md` (the README shown on the npm package page) called out "three one-keystroke setup questions" in two places and titled the post-init step "Paste the persona snippet into your client's custom-instructions slot" — pre-auto-installer wording that no longer matches what `init` actually does.
- **Printed walkthrough.** The Step 3 heading in `init`'s terminal output (rendered by `renderPersonaSnippetReco` in `packages/cli/src/init-render.ts`) likewise read "Paste the persona snippet into your client's custom-instructions slot", which is misleading immediately after the user has just said `Y` to the auto-install prompt and the persona block was written for them.

**What changes for users**

- The package README's Install blurb and Quickstart now describe four interactive setup questions and enumerate the auto-installer's per-client paths (`~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, `~/Documents/Cline/Rules/memento.md`).
- The Quickstart Step 3 heading on the package README is now "Confirm the persona snippet reaches your assistant"; the body splits into the auto-installed-already path (file-based clients) and the UI-only manual-paste path (Cowork, Claude Desktop, Claude Chat, Cursor User Rules).
- `init`'s printed Step 3 heading now reads "Confirm the persona snippet reaches your assistant" and the body explicitly acknowledges the auto-installed path before pointing UI-only / skipped clients at the manual paste in `docs/guides/teach-your-assistant.md`.

No command shape, flag, or exit-code change. No API change. Behavior of the auto-installer itself (added in 0.9.0) is unchanged — only the surrounding prose and the post-run walkthrough headings.

Internal cleanups landing in the same PR (not user-visible, included here for completeness): ADR-0028 prose updated to describe four prompts; `runInteractivePrompts` JSDoc updated to list all four side effects; `InitPrompter` interface JSDoc updated to "four interactive prompts"; `init-prompts.test.ts` updated to assert the fourth method (`promptInstallPersona`) that PR #78 forgot to wire into the existence-check test.
