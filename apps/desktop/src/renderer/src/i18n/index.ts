/**
 * Lightweight i18n: the source language is English (the literal strings in the
 * code), and `zh` maps each English string to Chinese. `t(s)` returns the
 * Chinese translation when the language is 'zh' (falling back to the English
 * source if a key is missing), else the English source. Reactive — components
 * using `useT()` re-render when the language setting changes.
 */
import { useAppStore } from '@/store/useAppStore';
import { zh } from './zh';

export type Translate = (s: string) => string;

export function useT(): Translate {
  const lang = useAppStore((s) => s.settings?.language ?? 'en');
  return (s: string) => (lang === 'zh' ? (zh[s] ?? s) : s);
}
