import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/tui/Markdown.js'
import { displayWidth } from '../src/tui/composer-state.js'

describe('terminal Markdown', () => {
  it.each([32, 80])('renders formatted content without overflow at %i columns', (width) => {
    const app = render(<Markdown width={width} text={'# Result\n\n**Ready** with `inline code`.\n\n- first\n- [x] done\n\n> quote\n\n```ts\nconst message = "中文内容以及一个比较长的字符串";\n```\n\n| File | Status |\n| --- | --- |\n| src/file.ts | completed |\n\n[docs](https://example.com)'} />)
    try {
      const frame = app.lastFrame() ?? ''
      expect(frame).toContain('Result')
      expect(frame).not.toContain('**Ready**')
      expect(frame).not.toContain('```')
      expect(frame).toContain('[x] done')
      expect(frame).toContain('1 │')
      expect(frame).toContain('src/file.ts')
      expect(frame).toContain('https://example.com')
      for (const line of frame.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(width)
    } finally { app.unmount() }
  })

  it('renders a partial fence while streaming and strips control bytes', () => {
    const app = render(<Markdown width={40} text={'```diff\n-old\n+new\x1b[2J'} />)
    try {
      expect(app.lastFrame()).toContain('-old')
      expect(app.lastFrame()).toContain('+new')
      expect(app.lastFrame()).not.toContain('\x1b')
    } finally { app.unmount() }
  })
})
