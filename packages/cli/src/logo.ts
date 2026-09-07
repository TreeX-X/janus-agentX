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

export function renderLogoPlain(): string {
  return 'JANUSX'
}
