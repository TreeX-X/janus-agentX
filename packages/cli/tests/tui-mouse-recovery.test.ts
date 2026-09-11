import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { maintainMouseReporting, MOUSE_DISABLE, MOUSE_ENABLE } from '../src/tui/scroll.js'

afterEach(() => vi.useRealTimers())

describe('mouse reporting recovery', () => {
  it('restores a lost mode after idle or resize and stops restoring on exit', () => {
    vi.useFakeTimers()
    const stdout = Object.assign(new EventEmitter(), { isTTY: true, write: vi.fn() })
    const cleanup = maintainMouseReporting(stdout)
    expect(stdout.write).toHaveBeenLastCalledWith(MOUSE_ENABLE)
    stdout.write.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(stdout.write).toHaveBeenCalledTimes(30)
    stdout.write.mockClear()
    stdout.emit('resize')
    expect(stdout.write).toHaveBeenCalledExactlyOnceWith(MOUSE_ENABLE)
    cleanup()
    expect(stdout.write).toHaveBeenLastCalledWith(MOUSE_DISABLE)
    stdout.write.mockClear()
    vi.advanceTimersByTime(60_000)
    stdout.emit('resize')
    expect(stdout.write).not.toHaveBeenCalled()
    expect(stdout.listenerCount('resize')).toBe(0)
  })

  it('does not write modes or register recovery on pipes', () => {
    const stdout = Object.assign(new EventEmitter(), { isTTY: false, write: vi.fn() })
    maintainMouseReporting(stdout)()
    expect(stdout.write).not.toHaveBeenCalled()
    expect(stdout.listenerCount('resize')).toBe(0)
  })
})
