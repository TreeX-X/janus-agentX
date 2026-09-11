import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isMouseCaptureSuspended,
  maintainMouseReporting,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  setMouseCaptureSuspended,
} from '../src/tui/scroll.js'

afterEach(() => {
  setMouseCaptureSuspended(false)
  vi.useRealTimers()
})

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

describe('mouse capture suspension (native box-selection mode)', () => {
  it('releases capture and skips the recovery reassert while suspended', () => {
    vi.useFakeTimers()
    const stdout = Object.assign(new EventEmitter(), { isTTY: true, write: vi.fn() })
    const cleanup = maintainMouseReporting(stdout)
    try {
      expect(stdout.write).toHaveBeenLastCalledWith(MOUSE_ENABLE)
      expect(isMouseCaptureSuspended()).toBe(false)
      stdout.write.mockClear()
      setMouseCaptureSuspended(true, stdout)
      expect(isMouseCaptureSuspended()).toBe(true)
      expect(stdout.write).toHaveBeenLastCalledWith(MOUSE_DISABLE)
      // Idle reasserts and resizes must not reclaim the mouse mid-selection.
      stdout.write.mockClear()
      vi.advanceTimersByTime(10_000)
      stdout.emit('resize')
      expect(stdout.write).not.toHaveBeenCalled()
      setMouseCaptureSuspended(false, stdout)
      expect(isMouseCaptureSuspended()).toBe(false)
      expect(stdout.write).toHaveBeenLastCalledWith(MOUSE_ENABLE)
    } finally {
      cleanup()
    }
  })

  it('toggles the flag without a stream and resets it on teardown', () => {
    setMouseCaptureSuspended(true)
    expect(isMouseCaptureSuspended()).toBe(true)
    setMouseCaptureSuspended(false)
    expect(isMouseCaptureSuspended()).toBe(false)

    const stdout = Object.assign(new EventEmitter(), { isTTY: true, write: vi.fn() })
    const cleanup = maintainMouseReporting(stdout)
    setMouseCaptureSuspended(true, stdout)
    expect(isMouseCaptureSuspended()).toBe(true)
    cleanup()
    expect(isMouseCaptureSuspended()).toBe(false)
    expect(stdout.write).toHaveBeenLastCalledWith(MOUSE_DISABLE)
  })
})
