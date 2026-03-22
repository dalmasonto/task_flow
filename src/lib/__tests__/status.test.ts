import { describe, it, expect } from 'vitest'
import { canTransition, getStatusLabel, getStatusColor } from '../status'

describe('canTransition', () => {
  it('allows not_started -> in_progress', () => {
    expect(canTransition('not_started', 'in_progress')).toBe(true)
  })

  it('rejects not_started -> done', () => {
    expect(canTransition('not_started', 'done')).toBe(false)
  })

  it('allows done -> in_progress (reopen)', () => {
    expect(canTransition('done', 'in_progress')).toBe(true)
  })

  it('rejects done -> paused', () => {
    expect(canTransition('done', 'paused')).toBe(false)
  })
})

describe('getStatusLabel', () => {
  it('returns human-readable label', () => {
    expect(getStatusLabel('in_progress')).toBe('In Progress')
    expect(getStatusLabel('partial_done')).toBe('Partial Done')
  })
})
