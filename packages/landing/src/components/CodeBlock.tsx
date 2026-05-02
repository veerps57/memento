import { useState } from 'react';

/**
 * A copy-pasteable terminal command. Click anywhere on the
 * block (or the `copy` button) to write to the clipboard.
 *
 * Used by the hero and quickstart sections — every install
 * command on the page goes through this component so the
 * "click to copy" affordance is uniform.
 */
export function CodeBlock({
  command,
  compact = false,
  className = '',
}: {
  readonly command: string;
  /**
   * Use a smaller font + word-wrap so a long command fits inside
   * a narrow card (e.g. the three-column quickstart steps).
   * Defaults to `false` — the hero command stays full-size.
   */
  readonly compact?: boolean;
  readonly className?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard API unavailable — user can still select the text manually */
    }
  };

  // `break-all` lets long single-token commands (no whitespace
  // to wrap on, e.g. `npx @scope/pkg-name`) wrap at any
  // character. With `whitespace-pre-wrap` runs of spaces are
  // preserved, so the leading `$ ` keeps its rhythm.
  const textSize = compact ? 'text-xs' : 'text-sm';
  const wrapClass = compact
    ? 'min-w-0 whitespace-pre-wrap break-all'
    : 'min-w-0 overflow-x-auto whitespace-pre';

  return (
    <button
      type="button"
      onClick={() => {
        void onCopy();
      }}
      aria-label={copied ? 'Copied' : `Copy command: ${command}`}
      className={`group flex w-full items-center justify-between gap-3 rounded-md border border-border bg-bg/60 px-4 py-3 text-left font-mono ${textSize} text-fg transition-colors hover:border-accent ${className}`}
    >
      <span className={wrapClass}>
        <span className="select-none text-muted">$ </span>
        {command}
      </span>
      <span className="shrink-0 text-xs uppercase tracking-widish text-muted group-hover:text-accent">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  );
}
