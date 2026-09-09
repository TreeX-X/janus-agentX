/**
 * @file ASCII JanusX wordmark for terminal hosts.
 * @description Transcribes `PIXEL_WORDMARK` from JanusX
 * `src/renderer/src/components/janus/JanusChat.tsx` (J/A/N/U/S 5x4 cells,
 * X 5x5 dual-tone) into block characters. `--plain` falls back to `JANUSX`.
 */

/** Exact copy of the chat pixel patterns: '1' = on, '0' = off, '2' = dim (X only). */
export const PIXEL_WORDMARK = {
  J: ['0011', '0001', '0001', '1001', '0110'],
  A: ['0110', '1001', '1111', '1001', '1001'],
  N: ['1001', '1101', '1011', '1001', '1001'],
  U: ['1001', '1001', '1001', '1001', '0110'],
  S: ['0111', '1000', '0110', '0001', '1110'],
  X: ['10002', '01020', '00100', '02010', '20001'],
} as const

const LETTER_ORDER = ['J', 'A', 'N', 'U', 'S', 'X'] as const

/** JanusX gray-orange tones for terminal hosts (mirrors the chat CSS). */
export const LOGO_TONE = {
  /** JANUS body: near-white gray. */
  lit: '#e8e8e8',
  /** X accent: JanusX orange. */
  orange: '#ff7830',
  /** X dim cells + secondary text. */
  dim: '#8a8f98',
} as const

function renderRow(letter: (typeof LETTER_ORDER)[number], rowIndex: number): string {
  const pattern = PIXEL_WORDMARK[letter][rowIndex] ?? ''
  return [...pattern].map((cell) => {
    if (cell === '1') return '██'
    if (cell === '2') return '░░'
    return '  '
  }).join('')
}

/** Five-row ASCII banner; same geometry as the chat empty-state logo. */
export function renderLogoAscii(): string {
  const rows: string[] = []
  for (let row = 0; row < 5; row += 1) {
    rows.push(LETTER_ORDER.map((letter) => renderRow(letter, row)).join('  '))
  }
  return rows.join('\n')
}

/** One same-tone run inside the X segment of a logo row. */
export interface LogoToneRun {
  text: string
  /** '1' = orange, '2' = dim, '0' = blank (kept so the X keeps its 10-char width). */
  tone: 'orange' | 'dim' | 'off'
}

const JANUS_LETTERS = ['J', 'A', 'N', 'U', 'S'] as const

/** JANUS segment of a logo row (single-tone, render with `LOGO_TONE.lit`). */
export function renderLogoJanusLine(rowIndex: number): string {
  return JANUS_LETTERS.map((letter) => renderRow(letter, rowIndex)).join('  ')
}

/** X segment of a logo row as tone runs (render '1' runs orange, '2' runs dim). */
export function renderLogoXLine(rowIndex: number): LogoToneRun[] {
  const pattern = PIXEL_WORDMARK.X[rowIndex] ?? ''
  const runs: LogoToneRun[] = []
  for (const cell of pattern) {
    const text = cell === '1' ? '██' : cell === '2' ? '░░' : '  '
    const tone = cell === '1' ? 'orange' : cell === '2' ? 'dim' : 'off'
    const last = runs[runs.length - 1]
    if (last && last.tone === tone) last.text += text
    else runs.push({ text, tone })
  }
  return runs
}

export function renderLogoPlain(): string {
  return 'JANUSX'
}
