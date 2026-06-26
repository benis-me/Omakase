import { useEffect, useMemo, useState } from 'react';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { cn } from '@/lib/utils';

export type CodeLanguage = 'markdown' | 'typescript' | 'javascript' | 'text';

/** Re-render when the app's light/dark class flips so CodeMirror reskins. */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

const transparentBg = EditorView.theme({
  '&': { backgroundColor: 'transparent', height: '100%', fontSize: '13px' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
  '.cm-scroller': {
    fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
    lineHeight: '1.6',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
});

export function CodeEditor({
  value,
  onChange,
  language = 'text',
  readOnly = false,
  className,
}: {
  value: string;
  onChange?: (value: string) => void;
  language?: CodeLanguage;
  readOnly?: boolean;
  className?: string;
}) {
  const dark = useIsDark();
  const extensions = useMemo<Extension[]>(() => {
    const langExt: Extension[] =
      language === 'markdown'
        ? [markdown()]
        : language === 'typescript'
          ? [javascript({ typescript: true })]
          : language === 'javascript'
            ? [javascript()]
            : [];
    return [...langExt, transparentBg, EditorView.lineWrapping];
  }, [language]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={dark ? 'dark' : 'light'}
      readOnly={readOnly}
      editable={!readOnly}
      height="100%"
      className={cn('h-full overflow-auto text-[13px]', className)}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: !readOnly,
        autocompletion: false,
        searchKeymap: false,
      }}
    />
  );
}
