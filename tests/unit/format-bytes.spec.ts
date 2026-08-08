/**
 * tests/unit/format-bytes.spec.ts — the whisper model-size label (FEAT-1k76hk).
 * Models span 75MB–2.9GB, so the MB↔GB boundary is the only interesting case.
 */
import { describe, expect, it } from 'vitest'
import { formatBytes } from '@renderer/components/formatBytes'

describe('formatBytes', () => {
  it('renders sub-gigabyte sizes in whole MB', () => {
    expect(formatBytes(147_000_000)).toBe('147 MB')
    expect(formatBytes(75_000_000)).toBe('75 MB')
  })

  it('switches to one-decimal GB at a gigabyte', () => {
    expect(formatBytes(1_000_000_000)).toBe('1.0 GB')
    expect(formatBytes(2_900_000_000)).toBe('2.9 GB')
  })

  it('renders nothing for absent or zero sizes rather than "0 MB"', () => {
    // model.status omits `bytes` for a model that is not installed; showing
    // "0 MB" next to it would read as an empty file rather than no file.
    expect(formatBytes(undefined)).toBe('')
    expect(formatBytes(0)).toBe('')
  })
})
