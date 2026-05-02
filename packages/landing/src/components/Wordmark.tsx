/**
 * The "memento_" wordmark with a blinking cursor.
 *
 * Mirrors the dashboard's top-left identity exactly — same
 * three-span layout, same fixed-size cursor block, same muted
 * underscore — so the marketing page and the in-product
 * dashboard read as the same artifact. If the dashboard's
 * wordmark changes, mirror the change here.
 *
 * Source of truth (do not drift): `Layout.tsx` in
 * `packages/dashboard/src/ui/components/`.
 */
export function Wordmark({ className = '' }: { readonly className?: string }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-sm font-semibold tracking-widish text-fg ${className}`}
      aria-label="memento"
    >
      <span>memento</span>
      <span className="font-normal text-muted">_</span>
      <span aria-hidden className="inline-block h-3 w-1.5 animate-pulse bg-fg" />
    </span>
  );
}
