// `<Placeholder>` — a single component used by every route that
// is part of the v0 nav structure but not yet implemented.
//
// Why have placeholders at all
// ----------------------------
//
// The sidebar advertises six destinations (overview, memory,
// conflicts, audit, config, system) so the user can see the
// shape of the dashboard at a glance. Routing those clicks to
// "404 not found" undermines the "this is the shape of the
// product" message. A small terminal-flavoured "this view is
// next" page is friendlier and tells the user what's coming
// without overcommitting to dates.
//
// Each page provides its own `path` and one-line `summary`
// describing what it will eventually do, mapped to the
// user-story ids from the design proposal so a curious user
// can grep the repo to see the spec.

export interface PlaceholderProps {
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly stories: readonly string[];
}

export function Placeholder({ path, title, summary, stories }: PlaceholderProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">{path}</span>
        <h1 className="font-sans text-xl font-semibold tracking-tight">{title}</h1>
      </header>
      <div className="rounded border border-border bg-bg px-4 py-6">
        <p className="font-sans text-sm text-fg/90">{summary}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-widish text-muted">
            tracked as
          </span>
          {stories.map((story) => (
            <code
              key={story}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted"
            >
              {story}
            </code>
          ))}
        </div>
      </div>
    </div>
  );
}
