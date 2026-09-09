import { useEffect, useState } from 'react'
import { Text } from 'ink'
import { LOGO_TONE } from '../logo.js'

export function duration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
}

export function Activity({ text, startedAt }: { text: string; startedAt?: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 120)
    return () => clearInterval(timer)
  }, [])
  const glyph = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][Math.floor(now / 120) % 10]
  return <Text color={LOGO_TONE.dim}>{glyph} {text}{startedAt !== undefined ? ` · ${duration(now - startedAt)}` : ''}</Text>
}
