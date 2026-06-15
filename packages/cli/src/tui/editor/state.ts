/**
 * A pure multiline text-editor model — the heart of the opencode-style composer.
 * It is independent of Ink: {@link Editor} normalizes Ink key events into
 * {@link EditorKey} and folds them through {@link reduceEditor}, so every cursor
 * and edit rule is unit-testable without a terminal.
 */
export interface EditorState {
  /** Always at least one line. */
  lines: string[];
  row: number;
  col: number;
}

/**
 * A normalized key event. `input` carries printable characters (empty for
 * control keys); `name` carries a recognized navigation/edit key; `ctrl`/`meta`
 * carry modifiers for emacs-style combos.
 */
export interface EditorKey {
  input: string;
  name?: 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'backspace' | 'delete' | 'newline';
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export function initialEditorState(): EditorState {
  return { lines: [''], row: 0, col: 0 };
}

export function editorText(state: EditorState): string {
  return state.lines.join('\n');
}

export function isEmpty(state: EditorState): boolean {
  return state.lines.length === 1 && state.lines[0] === '';
}

function clampCol(lines: string[], row: number, col: number): number {
  return Math.max(0, Math.min(col, lines[row]!.length));
}

/** Replace one line, returning a fresh lines array. */
function withLine(lines: string[], row: number, value: string): string[] {
  const next = lines.slice();
  next[row] = value;
  return next;
}

export function reduceEditor(state: EditorState, keyEvent: EditorKey): EditorState {
  const { lines, row, col } = state;
  const line = lines[row]!;

  // ── emacs combos ────────────────────────────────────────────────────
  if (keyEvent.ctrl && !keyEvent.meta) {
    switch (keyEvent.input) {
      case 'a':
        return { ...state, col: 0 };
      case 'e':
        return { ...state, col: line.length };
      case 'k':
        return { ...state, lines: withLine(lines, row, line.slice(0, col)) };
      case 'u':
        return { lines: withLine(lines, row, line.slice(col)), row, col: 0 };
      case 'w': {
        let i = col;
        while (i > 0 && line[i - 1] === ' ') i -= 1;
        while (i > 0 && line[i - 1] !== ' ') i -= 1;
        return { lines: withLine(lines, row, line.slice(0, i) + line.slice(col)), row, col: i };
      }
      default:
        return state; // other ctrl combos are handled above the editor
    }
  }

  // ── navigation ──────────────────────────────────────────────────────
  switch (keyEvent.name) {
    case 'home':
      return { ...state, col: 0 };
    case 'end':
      return { ...state, col: line.length };
    case 'left':
      if (col > 0) return { ...state, col: col - 1 };
      if (row > 0) return { ...state, row: row - 1, col: lines[row - 1]!.length };
      return state;
    case 'right':
      if (col < line.length) return { ...state, col: col + 1 };
      if (row < lines.length - 1) return { ...state, row: row + 1, col: 0 };
      return state;
    case 'up':
      if (row > 0) return { ...state, row: row - 1, col: clampCol(lines, row - 1, col) };
      return state;
    case 'down':
      if (row < lines.length - 1) return { ...state, row: row + 1, col: clampCol(lines, row + 1, col) };
      return state;
    case 'newline': {
      const before = line.slice(0, col);
      const after = line.slice(col);
      const next = lines.slice();
      next.splice(row, 1, before, after);
      return { lines: next, row: row + 1, col: 0 };
    }
    case 'backspace':
      if (col > 0) {
        return { lines: withLine(lines, row, line.slice(0, col - 1) + line.slice(col)), row, col: col - 1 };
      }
      if (row > 0) {
        const prev = lines[row - 1]!;
        const next = lines.slice();
        next.splice(row - 1, 2, prev + line);
        return { lines: next, row: row - 1, col: prev.length };
      }
      return state;
    case 'delete':
      if (col < line.length) {
        return { ...state, lines: withLine(lines, row, line.slice(0, col) + line.slice(col + 1)) };
      }
      if (row < lines.length - 1) {
        const next = lines.slice();
        next.splice(row, 2, line + lines[row + 1]!);
        return { lines: next, row, col };
      }
      return state;
    default:
      break;
  }

  // ── printable insertion ─────────────────────────────────────────────
  if (keyEvent.input && !keyEvent.ctrl && !keyEvent.meta) {
    // Guard against stray control characters reaching the buffer.
    const ch = [...keyEvent.input].filter((c) => c >= ' ').join('');
    if (!ch) return state;
    return { lines: withLine(lines, row, line.slice(0, col) + ch + line.slice(col)), row, col: col + ch.length };
  }
  return state;
}
