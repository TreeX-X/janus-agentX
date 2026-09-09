/**
 * Tool-card presentation: glyph/fg mapping per status and single-line text.
 */
import { describe, expect, it } from 'vitest'
import { TOOL_CARD_BG, TOOL_CARD_DONE, toolCardFg, toolCardGlyph, toolCardLine, type ToolCardFace } from '../src/tui/tool-card.js'
import { displayWidth, padToWidth } from '../src/tui/composer-state.js'

function card(partial: Partial<ToolCardFace> = {}): ToolCardFace {
  return { toolName: 'workspace_read', status: 'completed', ...partial }
}

describe('toolCardGlyph/toolCardFg', () => {
  it('maps every status to a distinct glyph', () => {
    expect(toolCardGlyph('ready')).toBe('◇')
    expect(toolCardGlyph('running')).toBe('◐')
    expect(toolCardGlyph('completed')).toBe('✔')
    expect(toolCardGlyph('failed')).toBe('✘')
  })

  it('keeps card foregrounds off the answer body color', () => {
    // Answers render in body #e8e8e8 on the terminal background; cards ride
    // the dark band with their own foregrounds (completed = warm sand).
    expect(toolCardFg('completed')).toBe(TOOL_CARD_DONE)
    expect(toolCardFg('completed')).not.toBe('#e8e8e8')
    expect(toolCardFg('failed')).toBe('red')
    expect(toolCardFg('running')).not.toBe(toolCardFg('ready'))
    expect(TOOL_CARD_BG).not.toBe('black')
  })
})

describe('toolCardLine', () => {
  it('renders glyph + tool + argument keys', () => {
    expect(toolCardLine(card({ status: 'ready', detail: 'path' }))).toBe('◇ workspace_read (path)')
  })

  it('marks running cards with an ellipsis', () => {
    expect(toolCardLine(card({ status: 'running' }))).toBe('◐ workspace_read…')
    expect(toolCardLine(card({ status: 'completed' }))).toBe('✔ workspace_read')
  })

  it('pads to an exact cell width for full-band rows', () => {
    expect(displayWidth(padToWidth(toolCardLine(card()), 40))).toBe(40)
  })
})
