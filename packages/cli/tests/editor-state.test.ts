import { describe, expect, it } from 'vitest';
import {
  editorText,
  initialEditorState,
  isEmpty,
  reduceEditor,
  type EditorKey,
  type EditorState,
} from '../src/tui/editor/state.js';

/** Type a string char-by-char (no control keys). */
function type(state: EditorState, text: string): EditorState {
  let s = state;
  for (const ch of text) s = reduceEditor(s, { input: ch });
  return s;
}

const key = (k: Partial<EditorKey>): EditorKey => ({ input: '', ...k });

describe('reduceEditor', () => {
  it('inserts printable characters and tracks the cursor', () => {
    const s = type(initialEditorState(), 'abc');
    expect(editorText(s)).toBe('abc');
    expect(s.row).toBe(0);
    expect(s.col).toBe(3);
    expect(isEmpty(initialEditorState())).toBe(true);
    expect(isEmpty(s)).toBe(false);
  });

  it('inserts a character in the middle after moving left', () => {
    let s = type(initialEditorState(), 'ac');
    s = reduceEditor(s, key({ name: 'left' })); // between a and c
    s = reduceEditor(s, { input: 'b' });
    expect(editorText(s)).toBe('abc');
    expect(s.col).toBe(2);
  });

  it('newline splits the current line at the cursor', () => {
    let s = type(initialEditorState(), 'aXc');
    s = reduceEditor(s, key({ name: 'left' })); // cursor before c (col 2)
    s = reduceEditor(s, key({ name: 'newline' }));
    expect(editorText(s)).toBe('aX\nc');
    expect(s.row).toBe(1);
    expect(s.col).toBe(0);
  });

  it('backspace removes within a line and merges across lines', () => {
    let s = type(initialEditorState(), 'ab');
    s = reduceEditor(s, key({ name: 'backspace' }));
    expect(editorText(s)).toBe('a');
    // Build two lines then backspace at col 0 to merge.
    s = type(initialEditorState(), 'ab');
    s = reduceEditor(s, key({ name: 'newline' }));
    s = type(s, 'cd'); // 'ab\ncd', cursor row1 col2
    s = reduceEditor(s, key({ name: 'home' })); // row1 col0
    s = reduceEditor(s, key({ name: 'backspace' }));
    expect(editorText(s)).toBe('abcd');
    expect(s.row).toBe(0);
    expect(s.col).toBe(2);
  });

  it('forward delete removes at the cursor and pulls up the next line', () => {
    let s = type(initialEditorState(), 'ab');
    s = reduceEditor(s, key({ name: 'newline' }));
    s = type(s, 'cd'); // ab\ncd
    s = reduceEditor(s, key({ name: 'up' })); // row0
    s = reduceEditor(s, key({ name: 'end' })); // end of 'ab'
    s = reduceEditor(s, key({ name: 'delete' })); // merge cd up
    expect(editorText(s)).toBe('abcd');
  });

  it('left/right wrap across line boundaries', () => {
    let s = type(initialEditorState(), 'a');
    s = reduceEditor(s, key({ name: 'newline' }));
    s = type(s, 'b'); // a\nb, row1 col1
    s = reduceEditor(s, key({ name: 'home' })); // row1 col0
    s = reduceEditor(s, key({ name: 'left' })); // wrap to end of row0
    expect([s.row, s.col]).toEqual([0, 1]);
    s = reduceEditor(s, key({ name: 'right' })); // wrap forward to row1 col0
    expect([s.row, s.col]).toEqual([1, 0]);
  });

  it('up/down clamp the column to the destination line length', () => {
    let s = type(initialEditorState(), 'longline');
    s = reduceEditor(s, key({ name: 'newline' }));
    s = type(s, 'xy'); // row1 'xy'
    s = reduceEditor(s, key({ name: 'up' })); // to row0, col clamped to <= 8
    expect(s.row).toBe(0);
    expect(s.col).toBe(2); // came from col 2 on row1
  });

  it('home/end and ctrl+a/ctrl+e move to line edges', () => {
    let s = type(initialEditorState(), 'hello');
    s = reduceEditor(s, key({ name: 'home' }));
    expect(s.col).toBe(0);
    s = reduceEditor(s, key({ name: 'end' }));
    expect(s.col).toBe(5);
    s = reduceEditor(s, key({ input: 'a', ctrl: true }));
    expect(s.col).toBe(0);
    s = reduceEditor(s, key({ input: 'e', ctrl: true }));
    expect(s.col).toBe(5);
  });

  it('ctrl+k kills to end of line, ctrl+u kills to start', () => {
    let s = type(initialEditorState(), 'hello world');
    s = reduceEditor(s, key({ name: 'home' }));
    for (let i = 0; i < 6; i++) s = reduceEditor(s, key({ name: 'right' })); // before 'world'
    s = reduceEditor(s, key({ input: 'k', ctrl: true }));
    expect(editorText(s)).toBe('hello ');
    s = reduceEditor(s, key({ input: 'u', ctrl: true }));
    expect(editorText(s)).toBe('');
  });

  it('ctrl+w deletes the previous word', () => {
    let s = type(initialEditorState(), 'foo bar baz');
    s = reduceEditor(s, key({ input: 'w', ctrl: true }));
    expect(editorText(s)).toBe('foo bar ');
    s = reduceEditor(s, key({ input: 'w', ctrl: true }));
    expect(editorText(s)).toBe('foo ');
  });
});
