/**
 * @file Tool-card presentation for the Ink discussion (no React/Ink).
 * @description Cards ride on a neutral dark band (`TOOL_CARD_BG`) so tool
 * activity never reads as assistant prose: answers are body text on the
 * terminal background, cards are status-colored text on the band. Pure
 * helpers, unit tested; `App.tsx` only paints rows full-width.
 */
import { LOGO_TONE, TUI_CHROME } from '../logo.js'
import type { ToolCardStatus } from './store.js'

/** Structural card face: satisfied by timeline `tool` blocks. */
export interface ToolCardFace {
  status: ToolCardStatus
  toolName?: string
  detail?: string
}

/** Band token kept for theme/tests; rows render transparent (pure-black
 * discipline) with a status-colored `▌` edge instead of a filled band. */
export const TOOL_CARD_BG = TUI_CHROME.cardBg
/** Completed-card foreground, distinct from answer body text. */
export const TOOL_CARD_DONE = TUI_CHROME.green

export function toolCardGlyph(status: ToolCardStatus): string {
  switch (status) {
    case 'preparing': return '·'
    case 'cancelled': return '■'
    case 'ready': return '◇'
    case 'running': return '◐'
    case 'completed': return '✔'
    case 'failed': return '✘'
  }
}

export function toolCardFg(status: ToolCardStatus): string {
  switch (status) {
    case 'preparing':
    case 'cancelled': return LOGO_TONE.dim
    case 'completed': return TOOL_CARD_DONE
    case 'failed': return 'red'
    case 'running': return LOGO_TONE.orange
    case 'ready': return LOGO_TONE.dim
  }
}

/** Single-line card text (status glyph + tool + argument keys). */
export function toolCardLine(card: ToolCardFace): string {
  const detail = card.detail ? ` (${card.detail})` : ''
  const tail = card.status === 'running' ? '…' : ''
  return `${toolCardGlyph(card.status)} ${card.toolName ?? 'tool'}${detail}${tail}`
}
