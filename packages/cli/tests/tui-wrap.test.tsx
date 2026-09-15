/**
 * Wrapped rows render long todo/option text in full (multi-line) instead
 * of truncating it with an ellipsis. Regression cover for the TUI
 * "content too long to read" report.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { WrappedRow } from '../src/tui/palette.js';
import { QuestionPanel } from '../src/tui/question-panel.js';

const LONG_LABEL = 'REST with a very long label that definitely exceeds sixty four cells of width';
const LONG_DESC = 'this description is also extremely long and would previously have been cut off with an ellipsis mark';

describe('wrapped rows show full text', () => {
  it('WrappedRow shows the full long body', () => {
    const body = `${LONG_LABEL}  ${LONG_DESC}`;
    const { lastFrame, unmount } = render(
      <Box flexDirection="column">
        <WrappedRow prefix="> 1 " body={body} width={40} selected color="#fff" />
      </Box>,
    );
    try {
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('…');
      for (const word of ['definitely', 'previously', 'ellipsis']) {
        expect(frame).toContain(word);
      }
    } finally {
      unmount();
    }
  });

  it('QuestionPanel shows full long option text', () => {
    const view = {
      questions: [{
        question: 'Which API style should we adopt for the new service layer implementation?',
        header: 'API style',
        multiple: false,
        options: [{ label: LONG_LABEL, description: LONG_DESC }],
      }],
      allowCustom: false,
    } as never;
    const { lastFrame, unmount } = render(
      <QuestionPanel view={view} onResolve={() => {}} width={60} />,
    );
    try {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('definitely');
      expect(frame).toContain('previously');
      expect(frame).not.toContain('…');
    } finally {
      unmount();
    }
  });
});
