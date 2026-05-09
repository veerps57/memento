// "Memento vs alternatives" data.
//
// Single source of truth shared by:
//   1. The visible Comparison section in App.tsx (rendered as a table).
//   2. The page's hidden body content visible to non-rendering AI
//      crawlers — the same data flows through React's SSR output.
//
// The columns and rows are intentionally sparse. The point is
// citation density: AI search engines surface comparison-table
// content disproportionately for "X vs Y" queries, but only if
// the contrast is concrete (yes/no), not hand-wavy. Each cell is
// a one-or-two-word verdict; nuance lives in the FAQ.

export interface ComparisonRow {
  readonly property: string;
  readonly memento: string;
  readonly chatgptMemory: string;
  readonly claudeProjects: string;
  readonly perClientFiles: string;
}

export const COMPARISON: {
  readonly columns: ReadonlyArray<{
    readonly key: keyof Omit<ComparisonRow, 'property'>;
    readonly label: string;
  }>;
  readonly rows: ReadonlyArray<ComparisonRow>;
} = {
  columns: [
    { key: 'memento', label: 'Memento' },
    { key: 'chatgptMemory', label: 'ChatGPT Memory' },
    { key: 'claudeProjects', label: 'Claude Projects' },
    { key: 'perClientFiles', label: 'Per-client config files' },
  ],
  rows: [
    {
      property: 'Storage location',
      memento: 'Local SQLite file',
      chatgptMemory: 'OpenAI cloud',
      claudeProjects: 'Anthropic cloud',
      perClientFiles: 'Local repo files',
    },
    {
      property: 'Works across AI tools',
      memento: 'Yes (any MCP client)',
      chatgptMemory: 'OpenAI only',
      claudeProjects: 'Anthropic only',
      perClientFiles: 'Per-tool only',
    },
    {
      property: 'Vendor lock-in',
      memento: 'None',
      chatgptMemory: 'OpenAI',
      claudeProjects: 'Anthropic',
      perClientFiles: 'Per-vendor format',
    },
    {
      property: 'Typed memory model',
      memento: 'Yes (fact, preference, decision, todo, snippet)',
      chatgptMemory: 'No (free-form text)',
      claudeProjects: 'No (free-form text)',
      perClientFiles: 'No (free-form text)',
    },
    {
      property: 'Append-only audit log',
      memento: 'Yes',
      chatgptMemory: 'No',
      claudeProjects: 'No',
      perClientFiles: 'Git (manual)',
    },
    {
      property: 'Conflict detection',
      memento: 'Built in',
      chatgptMemory: 'No',
      claudeProjects: 'No',
      perClientFiles: 'No',
    },
    {
      property: 'Confidence decay',
      memento: 'Yes (configurable half-life)',
      chatgptMemory: 'No',
      claudeProjects: 'No',
      perClientFiles: 'No',
    },
    {
      property: 'Data portability',
      memento: 'JSONL export / import',
      chatgptMemory: 'No (cloud-locked)',
      claudeProjects: 'No (cloud-locked)',
      perClientFiles: 'Copy files',
    },
    {
      property: 'Offline use',
      memento: 'Fully offline',
      chatgptMemory: 'Online only',
      claudeProjects: 'Online only',
      perClientFiles: 'Offline (read-only)',
    },
    {
      property: 'Cost',
      memento: 'Free, Apache-2.0',
      chatgptMemory: 'Bundled with subscription',
      claudeProjects: 'Bundled with subscription',
      perClientFiles: 'Free',
    },
  ],
};
