/**
 * @file Tool-card presentation for the Ink discussion (no React/Ink).
 * @description Cards ride on a dark warm band (`TOOL_CARD_BG`) so tool
 * activity never reads as assistant prose: answers are body text on the
 * terminal background, cards are status-colored text on the band. Pure
 * helpers, unit tested; `App.tsx` only paints rows full-width.
 */
import { LOGO_TONE } from '../logo.js'
import type { ToolCardStatus, ToolCardView } from './store.js'

/** Dark warm band behind every tool-card row. */
export const TOOL_CARD_BG = '#241c12'
/** Completed-card foreground: warm sand, distinct from answer body text. */
export const TOOL_CARD_DONE = '#d9c7a8'

export function toolCardGlyph(status: ToolCardStatus): string {
  switch (status) {
    case 'ready': return '◇'
    case 'running': return '◐'
    case 'completed': return '✔'
    case 'failed': return '✘'
  }
}

export function toolCardFg(status: ToolCardStatus): string {
  switch (status) {
    case 'completed': return TOOL_CARD_DONE
    case 'failed': return 'red'
    case 'running': return LOGO_TONE.orange
    case 'ready': return LOGO_TONE.dim
  }
}

/** Single-line card text (status glyph + tool + argument keys). */
export function toolCardLine(card: ToolCardView): string {
  const detail = card.detail ? ` (${card.detail})` : ''
  const tail = card.status === 'running' ? '…' : ''
  return `${toolCardGlyph(card.status)} ${card.toolName}${detail}${tail}`
}
