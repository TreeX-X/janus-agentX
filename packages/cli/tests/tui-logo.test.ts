/**
 * ASCII wordmark transcribes the chat PIXEL_WORDMARK geometry exactly.
 */
import { describe, expect, it } from 'vitest'
import { PIXEL_WORDMARK, renderLogoAscii, renderLogoPlain } from '../src/logo.js'

describe('logo', () => {
  it('renders five rows covering J/A/N/U/S/X in order', () => {
    const rows = renderLogoAscii().split('\n')
    expect(rows).toHaveLength(5)
    for (const row of rows) expect(row.length).toBeGreaterThan(20)
  })

  it('matches the chat pixel geometry cell for cell', () => {
    const rows = renderLogoAscii().split('\n')
    const letters = ['J', 'A', 'N', 'U', 'S', 'X'] as const
    // Each cell renders 2 chars wide; letters joined by 2 spaces.
    // J/A/N/U/S are 4 cells wide (8 chars), X is 5 cells wide (10 chars).
    const widths = [8, 8, 8, 8, 8, 10]
    let offset = 0
    letters.forEach((letter, li) => {
      for (let row = 0; row < 5; row += 1) {
        const pattern = (PIXEL_WORDMARK[letter] as readonly string[])[row] ?? ''
        const segment = rows[row].slice(offset, offset + widths[li])
        expect(segment.length).toBe(widths[li])
        ;[...pattern].forEach((cell, ci) => {
          const pair = segment.slice(ci * 2, ci * 2 + 2)
          if (cell === '1') expect(pair).toBe('██')
          else if (cell === '2') expect(pair).toBe('░░')
          else expect(pair).toBe('  ')
        })
      }
      offset += widths[li] + 2
    })
  })

  it('falls back to plain text', () => {
    expect(renderLogoPlain()).toBe('JANUSX')
  })
})
