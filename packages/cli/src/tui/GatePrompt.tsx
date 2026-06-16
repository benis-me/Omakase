/**
 * A risk-gate / acceptance approval prompt (factory-style). When a run opens a
 * gate, the conversation pauses here for an approve/reject decision, written
 * back via client.answerGate. Fuses omakase's human-in-the-loop gating.
 */
import React from 'react';

export function GatePrompt(props: {
  question: string;
  onAnswer: (answer: 'approve' | 'reject') => void;
}): React.ReactElement {
  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, border: true, borderColor: 'yellow', paddingLeft: 1, paddingRight: 1 }}>
      <text fg="yellow">{`⚠ ${props.question}`}</text>
      <select
        focused
        options={[
          { name: 'approve — continue the run', value: 'approve' },
          { name: 'reject — stop and revise', value: 'reject' },
        ]}
        onSelect={(_i: number, opt: { value?: string } | null) => {
          if (opt?.value === 'approve' || opt?.value === 'reject') props.onAnswer(opt.value);
        }}
      />
    </box>
  );
}
