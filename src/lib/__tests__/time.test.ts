import { describe, it, expect } from 'vitest'
import { formatDuration, computeSessionDuration, computeTotalTime } from '../time'

describe('computeTotalTime', () => {
  it('sums durations of multiple completed sessions', () => {
    const sessions = [
      { id: 1, taskId: 1, start: new Date('2026-01-01T10:00:00'), end: new Date('2026-01-01T10:30:00') },
      { id: 2, taskId: 1, start: new Date('2026-01-01T11:00:00'), end: new Date('2026-01-01T11:45:00') },
    ]
    expect(computeTotalTime(sessions)).toBe((30 + 45) * 60 * 1000)
  })

  it('returns 0 for empty sessions', () => {
    expect(computeTotalTime([])).toBe(0)
  })
})

describe('formatDuration', () => {
  it('formats zero', () => {
    expect(formatDuration(0)).toBe('00:00:00')
  })

  it('formats hours, minutes, seconds', () => {
    const ms = (2 * 3600 + 15 * 60 + 30) * 1000
    expect(formatDuration(ms)).toBe('02:15:30')
  })

  it('handles large durations', () => {
    const ms = (100 * 3600 + 5 * 60 + 3) * 1000
    expect(formatDuration(ms)).toBe('100:05:03')
  })
})

describe('computeSessionDuration', () => {
  it('computes duration for completed session', () => {
    const start = new Date('2026-01-01T10:00:00')
    const end = new Date('2026-01-01T10:30:00')
    expect(computeSessionDuration({ id: 1, taskId: 1, start, end })).toBe(30 * 60 * 1000)
  })

  it('computes duration for active session using now', () => {
    const start = new Date(Date.now() - 60000)
    const duration = computeSessionDuration({ id: 1, taskId: 1, start })
    expect(duration).toBeGreaterThanOrEqual(59000)
    expect(duration).toBeLessThan(62000)
  })
})
