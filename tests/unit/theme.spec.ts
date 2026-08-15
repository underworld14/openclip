/**
 * tests/unit/theme.spec.ts — persisted light/dark preference (BUG-qcvhcn).
 *
 * Pure functions injected with a fake storage, so no jsdom/localStorage is
 * needed — mirrors the fake-safeStorage pattern the rest of the suite uses.
 */

import { describe, expect, it } from 'vitest'
import { readStoredTheme, writeStoredTheme, THEME_STORAGE_KEY } from '@renderer/components/theme'

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = { ...initial }
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    }
  } as unknown as Storage
}

function throwingStorage(): Storage {
  return {
    getItem: () => {
      throw new Error('storage unavailable')
    },
    setItem: () => {
      throw new Error('storage unavailable')
    }
  } as unknown as Storage
}

describe('readStoredTheme', () => {
  it('defaults to dark when nothing is stored', () => {
    expect(readStoredTheme(fakeStorage())).toBe(true)
  })

  it('reads back a persisted "light" choice', () => {
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'light' }))).toBe(false)
  })

  it('reads back a persisted "dark" choice', () => {
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe(true)
  })

  it('defaults to dark for an unrecognised stored value', () => {
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'sepia' }))).toBe(true)
  })

  it('defaults to dark when storage throws (never blocks the app)', () => {
    expect(readStoredTheme(throwingStorage())).toBe(true)
  })
})

describe('writeStoredTheme', () => {
  it('persists "dark" and "light" under THEME_STORAGE_KEY', () => {
    const storage = fakeStorage()
    writeStoredTheme(true, storage)
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    writeStoredTheme(false, storage)
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('a storage failure does not throw (best-effort)', () => {
    expect(() => writeStoredTheme(true, throwingStorage())).not.toThrow()
  })
})
