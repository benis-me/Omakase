import { useMemo } from 'react';
import { marked } from 'marked';
import { cn } from '@/lib/utils';

/**
 * Defense-in-depth scrub for locally-authored / agent-generated markdown. The
 * CSP already blocks inline scripts and innerHTML-injected <script> never runs;
 * this also strips event-handler attributes and javascript: URLs.
 */
function sanitize(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"');
}

export function MarkdownPreview({ source, className }: { source: string; className?: string }) {
  const html = useMemo(
    () => sanitize(marked.parse(source ?? '', { async: false, gfm: true, breaks: false }) as string),
    [source],
  );
  return (
    <div
      className={cn('markdown-body text-[13px] leading-relaxed', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
