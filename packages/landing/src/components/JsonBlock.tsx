import { useState } from 'react';

/**
 * A copy-pasteable multi-line code block. Used by the landing's
 * step 3 (the "paste the snippet" step) to show a real, valid
 * MCP-server config the user can copy verbatim.
 *
 * Differs from `CodeBlock` in three ways:
 *
 *   - Multi-line content rendered in a `<pre>` so indentation
 *     and newlines are preserved exactly (no break-all).
 *   - Copy button is absolutely positioned in the top-right so
 *     it doesn't sit alongside the content (which would force
 *     awkward width math on every block).
 *   - No leading `$ ` prompt — the content here is a JSON
 *     fragment, not a shell command.
 */
export function JsonBlock({
  json,
  className = '',
}: {
  readonly json: string;
  readonly className?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard API unavailable — user can still select the text manually */
    }
  };

  return (
    <div className={`relative rounded-md border border-border bg-bg/60 ${className}`}>
      <button
        type="button"
        onClick={() => {
          void onCopy();
        }}
        aria-label={copied ? 'Copied' : 'Copy JSON snippet'}
        className="absolute right-2 top-2 z-10 inline-flex items-center rounded border border-border bg-bg/80 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widish text-muted backdrop-blur transition-colors hover:border-accent hover:text-accent"
      >
        {copied ? 'copied' : 'copy'}
      </button>
      <pre className="overflow-x-auto p-3 pr-16 font-mono text-[11px] leading-relaxed text-fg/85">
        <code>{json}</code>
      </pre>
    </div>
  );
}
