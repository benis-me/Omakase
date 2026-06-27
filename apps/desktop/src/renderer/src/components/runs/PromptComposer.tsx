import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { File, FileText, Paperclip, SquareSlash, Workflow } from 'lucide-react';
import type { CommandDocDto, SpecDoc, WorkflowDoc } from '@shared/types';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A rich-text prompt composer built on an uncontrolled `contentEditable` div.
 *
 * - IME-safe: an in-progress composition (the user typing Chinese) never opens
 *   the `@` picker or gets mangled — chip insertion / `@` detection are gated on
 *   `compositionend`.
 * - `@` opens a caret-anchored picker of mentionable specs/commands/workflows,
 *   filtered by the text typed after `@`, fully keyboard-navigable.
 * - Selecting an item, or dropping/attaching a file, inserts an atomic
 *   `contentEditable={false}` chip carrying `data-ref` + `data-type`.
 * - `onChange` receives the serialized prompt: text nodes verbatim, chips as
 *   their ` <path-ref> ` reference (see {@link serializeEditor}).
 */

type MentionType = 'spec' | 'command' | 'workflow';
type ChipType = MentionType | 'file';

interface MentionItem {
  type: MentionType;
  /** Stable id/name used to build the path reference. */
  key: string;
  /** Human label shown in the picker and the chip. */
  label: string;
  /** The path reference inserted into the serialized prompt. */
  ref: string;
}

const CHIP_ATTR = 'data-omk-chip';

const TYPE_ICON: Record<ChipType, typeof FileText> = {
  spec: FileText,
  command: SquareSlash,
  workflow: Workflow,
  file: File,
};

function specRef(id: string): string {
  return `.omks/specs/${id}.md`;
}
function commandRef(name: string): string {
  return `.omks/commands/${name}.md`;
}
function workflowRef(id: string): string {
  return `.omks/workflows/${id}.ts`;
}

/** Walk the editor's children in order; text → its text, chips → ` <ref> `. */
function serializeEditor(root: HTMLElement): string {
  let out = '';
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
    } else if (node instanceof HTMLElement && node.hasAttribute(CHIP_ATTR)) {
      out += ` ${node.getAttribute('data-ref') ?? ''} `;
    } else if (node instanceof HTMLElement) {
      // A stray <br> (empty line) or pasted element — keep its text only.
      if (node.tagName === 'BR') out += '\n';
      else out += node.textContent ?? '';
    }
  });
  return out;
}

/** Make a chip span. Atomic (`contentEditable={false}`), styled to match the app. */
function makeChip(type: ChipType, ref: string, label: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.setAttribute(CHIP_ATTR, '');
  chip.setAttribute('data-ref', ref);
  chip.setAttribute('data-type', type);
  chip.setAttribute('contenteditable', 'false');
  chip.className =
    'inline-flex items-center gap-1 rounded bg-omk/15 text-omk px-1.5 py-0.5 text-[12px] align-baseline select-none mx-0.5 font-medium';

  // lucide renders to SVG at runtime in React; in raw DOM we inline a tiny glyph
  // container and let the label carry meaning. Use a leading dot-sized icon box.
  const icon = document.createElement('span');
  icon.className = 'inline-block size-3 shrink-0';
  icon.setAttribute('data-chip-icon', type);
  icon.innerHTML = CHIP_ICON_SVG[type];
  chip.appendChild(icon);

  const text = document.createElement('span');
  text.textContent = label;
  chip.appendChild(text);

  return chip;
}

// Inline SVGs (lucide paths) so chips built via the DOM API still show an icon.
// FileText, SquareSlash, Workflow, File — 16×16 lucide outlines.
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">';
const CHIP_ICON_SVG: Record<ChipType, string> = {
  spec: `${SVG_OPEN}<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`,
  command: `${SVG_OPEN}<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 8 6 8"/><path d="m15 8-6 8"/></svg>`,
  workflow: `${SVG_OPEN}<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>`,
  file: `${SVG_OPEN}<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>`,
};

interface PickerState {
  query: string;
  /** Viewport coords of the caret, for positioning the popover. */
  top: number;
  left: number;
  index: number;
}

export function PromptComposer({
  onChange,
  placeholder,
}: {
  onChange: (serialized: string) => void;
  placeholder?: string;
}): React.JSX.Element {
  const t = useT();
  const workspaceRoot = useAppStore((s) => s.active?.path ?? null);

  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [empty, setEmpty] = useState(true);
  const [picker, setPicker] = useState<PickerState | null>(null);

  const [specs, setSpecs] = useState<SpecDoc[]>([]);
  const [commands, setCommands] = useState<CommandDocDto[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDoc[]>([]);

  // Load mentionable sources once on mount.
  useEffect(() => {
    let alive = true;
    void Promise.all([
      window.omakase.specs.list(),
      window.omakase.commands.list(),
      window.omakase.workflows.list(),
    ]).then(([s, c, w]) => {
      if (!alive) return;
      setSpecs(s);
      setCommands(c);
      setWorkflows(w);
    });
    return () => {
      alive = false;
    };
  }, []);

  const allItems = useMemo<MentionItem[]>(() => {
    return [
      ...specs.map<MentionItem>((s) => ({
        type: 'spec',
        key: s.id,
        label: s.title || s.id,
        ref: specRef(s.id),
      })),
      ...commands.map<MentionItem>((c) => ({
        type: 'command',
        key: c.name,
        label: c.name,
        ref: commandRef(c.name),
      })),
      ...workflows.map<MentionItem>((w) => ({
        type: 'workflow',
        key: w.id,
        label: w.name || w.id,
        ref: workflowRef(w.id),
      })),
    ];
  }, [specs, commands, workflows]);

  const filtered = useMemo<MentionItem[]>(() => {
    if (!picker) return [];
    const q = picker.query.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((it) => it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q));
  }, [picker, allItems]);

  // Grouped view for rendering, preserving the spec→command→workflow order.
  const groups = useMemo(() => {
    const order: { type: MentionType; label: string }[] = [
      { type: 'spec', label: t('Specs') },
      { type: 'command', label: t('Commands') },
      { type: 'workflow', label: t('Workflows') },
    ];
    return order
      .map((g) => ({ ...g, items: filtered.filter((it) => it.type === g.type) }))
      .filter((g) => g.items.length > 0);
  }, [filtered, t]);

  const emit = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    onChange(serializeEditor(root));
    setEmpty(root.textContent?.length === 0 && root.querySelector(`[${CHIP_ATTR}]`) === null);
  }, [onChange]);

  // ── `@` detection ──────────────────────────────────────────────────────────
  // Caret-anchored popover position from the current selection rect.
  const caretRect = useCallback((): { top: number; left: number } | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    let rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    // Empty/collapsed ranges in some browsers return a zero rect; fall back to
    // a temporary marker to get a real position.
    if (!rect || (rect.top === 0 && rect.left === 0)) {
      const marker = document.createElement('span');
      marker.textContent = '​';
      range.insertNode(marker);
      rect = marker.getBoundingClientRect();
      marker.parentNode?.removeChild(marker);
    }
    return { top: rect.bottom, left: rect.left };
  }, []);

  const updatePicker = useCallback(() => {
    if (composingRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
      setPicker(null);
      return;
    }
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      setPicker(null);
      return;
    }
    const text = node.textContent ?? '';
    const upto = text.slice(0, sel.anchorOffset);
    const m = /@([\w-]*)$/.exec(upto);
    if (!m) {
      setPicker(null);
      return;
    }
    const pos = caretRect();
    if (!pos) {
      setPicker(null);
      return;
    }
    setPicker((prev) => ({
      query: m[1],
      top: pos.top,
      left: pos.left,
      index: prev ? prev.index : 0,
    }));
  }, [caretRect]);

  // Clamp the highlighted index whenever the filtered set shrinks.
  useEffect(() => {
    if (!picker) return;
    if (picker.index > Math.max(0, filtered.length - 1)) {
      setPicker((p) => (p ? { ...p, index: Math.max(0, filtered.length - 1) } : p));
    }
  }, [filtered.length, picker]);

  // ── Chip insertion ─────────────────────────────────────────────────────────
  /** Replace a `@query` run at the caret with a chip + trailing space. */
  const insertMention = useCallback(
    (item: MentionItem) => {
      const root = editorRef.current;
      const sel = window.getSelection();
      if (!root || !sel || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      if (!node || node.nodeType !== Node.TEXT_NODE) return;

      const text = node.textContent ?? '';
      const upto = text.slice(0, sel.anchorOffset);
      const m = /@([\w-]*)$/.exec(upto);
      if (!m) return;
      const start = sel.anchorOffset - m[0].length;

      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, sel.anchorOffset);
      range.deleteContents();

      const chip = makeChip(item.type, item.ref, item.label);
      const space = document.createTextNode(' ');
      range.insertNode(space);
      range.insertNode(chip);

      // Caret after the trailing space.
      const after = document.createRange();
      after.setStartAfter(space);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);

      setPicker(null);
      emit();
    },
    [emit],
  );

  /** Insert a file chip at the caret (or at the end if no caret), + trailing space. */
  const insertFileChip = useCallback(
    (absPath: string) => {
      const root = editorRef.current;
      if (!root) return;
      const ref =
        workspaceRoot && isUnder(absPath, workspaceRoot) ? relativeTo(absPath, workspaceRoot) : absPath;
      const label = basename(absPath);

      const sel = window.getSelection();
      let range: Range;
      if (sel && sel.rangeCount > 0 && root.contains(sel.anchorNode)) {
        range = sel.getRangeAt(0);
        range.deleteContents();
      } else {
        range = document.createRange();
        range.selectNodeContents(root);
        range.collapse(false);
      }

      const chip = makeChip('file', ref, label);
      const space = document.createTextNode(' ');
      range.insertNode(space);
      range.insertNode(chip);

      const after = document.createRange();
      after.setStartAfter(space);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);

      root.focus();
      emit();
    },
    [emit, workspaceRoot],
  );

  // ── Event handlers ─────────────────────────────────────────────────────────
  const onInput = useCallback(() => {
    if (composingRef.current) return;
    emit();
    updatePicker();
  }, [emit, updatePicker]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // Never intercept keys while an IME composition is in flight.
      if (composingRef.current || e.nativeEvent.isComposing) return;

      // Picker navigation takes priority over editor defaults.
      if (picker && filtered.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setPicker((p) => (p ? { ...p, index: (p.index + 1) % filtered.length } : p));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setPicker((p) => (p ? { ...p, index: (p.index - 1 + filtered.length) % filtered.length } : p));
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const item = filtered[picker.index];
          if (item) insertMention(item);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setPicker(null);
          return;
        }
      }

      // Atomic chip deletion: if the caret sits right after a chip, Backspace
      // removes the whole chip rather than entering it.
      if (e.key === 'Backspace') {
        const sel = window.getSelection();
        if (sel && sel.isCollapsed && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const chip = chipBeforeCaret(range);
          if (chip) {
            e.preventDefault();
            chip.remove();
            emit();
            updatePicker();
          }
        }
      }
    },
    [picker, filtered, insertMention, emit, updatePicker],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      // Force plain-text paste so rich HTML can't smuggle in nodes we don't serialize.
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    },
    [],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      for (const f of files) {
        const path = window.omakase.getPathForFile(f);
        if (path) insertFileChip(path);
      }
    },
    [insertFileChip],
  );

  const [dragOver, setDragOver] = useState(false);

  const onPickFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      for (const f of files) {
        const path = window.omakase.getPathForFile(f);
        if (path) insertFileChip(path);
      }
      e.target.value = '';
    },
    [insertFileChip],
  );

  const onAttachFolder = useCallback(() => {
    void window.omakase.workspaces.pickFolder().then((folder) => {
      if (folder) insertFileChip(folder);
    });
  }, [insertFileChip]);

  // Close picker on outside interaction / scroll.
  useEffect(() => {
    if (!picker) return;
    const close = (): void => setPicker(null);
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [picker]);

  return (
    <div className="relative">
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          // Composition settled — now it's safe to re-evaluate `@` + serialize.
          emit();
          updatePicker();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'min-h-[7rem] max-h-72 w-full overflow-y-auto rounded-md border border-input bg-transparent px-3 py-2 text-[13px] font-mono leading-relaxed shadow-xs outline-none transition-[color,box-shadow]',
          'whitespace-pre-wrap break-words',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
          dragOver && 'border-omk ring-[3px] ring-omk/30',
        )}
      />

      {empty && (
        <div className="pointer-events-none absolute left-3 top-2 select-none font-mono text-[13px] text-muted-foreground">
          {placeholder}
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
          <Paperclip />
          {t('Attach')}
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onAttachFolder}>
          {t('Folder…')}
        </Button>
        <span className="text-[11px] text-muted-foreground">{t('Type @ to mention a spec, command, or workflow')}</span>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={onPickFiles}
        />
      </div>

      {picker &&
        groups.length > 0 &&
        createPortal(
          <MentionPicker
            top={picker.top}
            left={picker.left}
            groups={groups}
            activeIndex={picker.index}
            flat={filtered}
            onPick={insertMention}
          />,
          document.body,
        )}
    </div>
  );
}

function MentionPicker({
  top,
  left,
  groups,
  activeIndex,
  flat,
  onPick,
}: {
  top: number;
  left: number;
  groups: { type: MentionType; label: string; items: MentionItem[] }[];
  activeIndex: number;
  flat: MentionItem[];
  onPick: (item: MentionItem) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const activeItem = flat[activeIndex];

  // Flip above the caret if it would overflow the viewport bottom.
  const [pos, setPos] = useState({ top, left });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nextTop = top + 4;
    let nextLeft = left;
    if (nextTop + rect.height > window.innerHeight - 8) {
      nextTop = top - rect.height - 18;
    }
    if (nextLeft + rect.width > window.innerWidth - 8) {
      nextLeft = window.innerWidth - rect.width - 8;
    }
    setPos({ top: Math.max(8, nextTop), left: Math.max(8, nextLeft) });
  }, [top, left, groups]);

  // Keep the active row in view.
  useEffect(() => {
    ref.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      ref={ref}
      className="fixed z-50 max-h-72 w-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ top: pos.top, left: pos.left }}
    >
      {groups.map((g) => (
        <div key={g.type}>
          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{g.label}</div>
          {g.items.map((item) => {
            const Icon = TYPE_ICON[item.type];
            const isActive = activeItem?.type === item.type && activeItem.key === item.key;
            return (
              <button
                key={`${item.type}:${item.key}`}
                type="button"
                data-active={isActive}
                // Use mousedown so the click fires before the editor loses focus.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(item);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] outline-none',
                  isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                )}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── DOM/path helpers ───────────────────────────────────────────────────────

/** The chip element immediately before a collapsed caret, if any. */
function chipBeforeCaret(range: Range): HTMLElement | null {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    // Caret must be at the very start of the text node for the previous sibling
    // (a chip) to be "right before" it.
    if (startOffset !== 0) return null;
    const prev = startContainer.previousSibling;
    return isChip(prev) ? (prev as HTMLElement) : null;
  }
  // Element container: the node just before the offset.
  const prev = startContainer.childNodes[startOffset - 1] ?? null;
  return isChip(prev) ? (prev as HTMLElement) : null;
}

function isChip(node: Node | null): boolean {
  return node instanceof HTMLElement && node.hasAttribute(CHIP_ATTR);
}

function normalize(p: string): string {
  return p.replace(/\/+$/, '');
}
function isUnder(path: string, root: string): boolean {
  const r = normalize(root);
  return path === r || path.startsWith(`${r}/`);
}
function relativeTo(path: string, root: string): string {
  const r = normalize(root);
  if (path === r) return '.';
  return path.slice(r.length + 1);
}
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}
