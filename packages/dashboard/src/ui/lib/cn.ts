// `cn` — class-name composer (the shadcn/ui pattern).
//
// Combines clsx (conditional class names) and tailwind-merge
// (conflict resolution: `cn('p-2', 'p-4')` → `'p-4'`). Without
// tailwind-merge, conflicting Tailwind utility classes leave
// both in the rendered HTML and the cascade picks one in
// ill-defined order; with it, the later class always wins.

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
