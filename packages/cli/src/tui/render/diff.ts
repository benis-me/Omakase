/**
 * A minimal unified-diff classifier for rendering file changes in the transcript.
 * Pure: it tags each line so {@link renderDiff} can colorize additions/deletions/
 * hunks without re-parsing.
 */
export interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'hunk' | 'meta';
  text: string;
}

export function tokenizeDiff(patch: string): DiffLine[] {
  return patch.split('\n').map((text): DiffLine => {
    if (/^(diff |index |---|\+\+\+|new file|deleted file|similarity |rename )/.test(text)) {
      return { kind: 'meta', text };
    }
    if (text.startsWith('@@')) return { kind: 'hunk', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    return { kind: 'context', text };
  });
}
