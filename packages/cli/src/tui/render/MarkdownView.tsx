/**
 * Renders tokenized markdown to Ink elements: headings bold, inline bold/italic/
 * code styled, lists with markers, and fenced code blocks dimmed — with `diff`/
 * `patch` code blocks delegated to the {@link DiffView} colorizer. Pure presentation
 * over {@link tokenizeMarkdown}.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { tokenizeMarkdown, type InlineSpan } from './markdown.js';
import { DiffView } from './DiffView.js';

function Inline(props: { spans: InlineSpan[] }): React.ReactElement {
  return (
    <Text>
      {props.spans.map((s, i) => (
        <Text key={i} bold={s.bold} italic={s.italic} color={s.code ? 'yellow' : undefined}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

export function MarkdownView(props: { source: string }): React.ReactElement {
  const blocks = tokenizeMarkdown(props.source);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return (
              <Text key={i} bold color="cyan">
                <Inline spans={b.spans} />
              </Text>
            );
          case 'paragraph':
            return <Inline key={i} spans={b.spans} />;
          case 'list-item':
            return (
              <Box key={i}>
                <Text dimColor>{b.marker} </Text>
                <Inline spans={b.spans} />
              </Box>
            );
          case 'code-block':
            if (b.lang === 'diff' || b.lang === 'patch') {
              return <DiffView key={i} patch={b.lines.join('\n')} />;
            }
            return (
              <Box key={i} flexDirection="column">
                {b.lines.map((line, j) => (
                  <Text key={j} dimColor>
                    {'  '}
                    {line || ' '}
                  </Text>
                ))}
              </Box>
            );
        }
      })}
    </Box>
  );
}
