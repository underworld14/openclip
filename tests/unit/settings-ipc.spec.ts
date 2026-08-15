/**
 * tests/unit/settings-ipc.spec.ts — the settings document survives bad input and
 * bad luck (BUG-yxvrwx).
 *
 * Three defects, all in the same file:
 *
 *  1. SET_SETTINGS merged the patch and wrote it with no validation, so a
 *     malformed value persisted a document that would not parse next time.
 *  2. GET_SETTINGS answered an unparseable document by returning DEFAULT_SETTINGS
 *     — silently reverting provider, model and language with no toast and no log.
 *     The user's next generate then ran against the wrong provider and failed
 *     with an error pointing nowhere near the cause.
 *  3. The write was a bare `writeFileSync`, which truncates before it writes, so
 *     a crash or full disk mid-write produced exactly the corruption in (2).
 *
 * The realistic trigger is not a bad UI value — every reachable patch is enum- or
 * string-constrained at source — but a truncated file, or a newly REQUIRED field
 * added to the schema, which would reset settings for every existing user on
 * upgrade. So these test the file's behaviour directly rather than via the UI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSettings, updateSettings } from '@main/ipc/settings'
import { Settings } from '@shared/schema'
import { settingsFixture } from '../fixtures/contract'

// The handler resolves its path through a lazy `require('electron')`, which
// `vi.mock('electron')` cannot intercept (same constraint media-protocol.spec.ts
// documents). So we drive the pure, path-taking core the handler delegates to.
let file: string

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'openclip-settings-')), 'settings.json')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SET_SETTINGS: a bad patch must not clobber good settings', () => {
  it('rejects a schema-invalid patch and leaves the stored document intact', async () => {
    updateSettings(file, { aiProvider: 'anthropic', model: 'claude-sonnet-5', language: 'id' })

    expect(() => updateSettings(file, { maxClips: Number.NaN })).toThrow(/INPUT_INVALID settings/)

    const after = readSettings(file)
    expect(after.aiProvider).toBe('anthropic')
    expect(after.model).toBe('claude-sonnet-5')
    expect(after.language).toBe('id')
  })

  it('never writes an unvalidated document to disk', async () => {
    updateSettings(file, { aiProvider: 'google' })
    try {
      updateSettings(file, { maxClips: Number.NaN })
    } catch {
      /* expected */
    }

    // The document on disk must still SATISFY THE SCHEMA. Asserting "maxClips is
    // not NaN" would pass on the old code too, because JSON.stringify silently
    // encodes NaN as null — the file was corrupt in a way that assertion missed.
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.aiProvider).toBe('google')
    expect(Settings.safeParse(onDisk).success).toBe(true)
  })
})

describe('GET_SETTINGS: a damaged document is repaired, not discarded', () => {
  it('keeps the fields that still parse and resets only the broken one', async () => {
    updateSettings(file, { aiProvider: 'anthropic', model: 'claude-sonnet-5', language: 'id' })

    // Corrupt exactly one field, the way a schema change or a bad hand-edit would.
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.maxClips = null
    writeFileSync(file, JSON.stringify(doc), 'utf8')

    const after = readSettings(file)
    expect(after.aiProvider).toBe('anthropic')
    expect(after.model).toBe('claude-sonnet-5')
    expect(after.language).toBe('id')
    expect(after.maxClips).toBe(5) // the default, for the one field that failed
    expect(console.warn).toHaveBeenCalled() // and it is not silent
  })

  it('preserves a field a NEWER app version added, rather than stripping it', async () => {
    updateSettings(file, { aiProvider: 'anthropic' })
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.somethingFromTheFuture = 'keep me'
    doc.maxClips = null
    writeFileSync(file, JSON.stringify(doc), 'utf8')

    const after = readSettings(file) as unknown as Record<string, unknown>
    expect(after.somethingFromTheFuture).toBe('keep me')
    expect(after.aiProvider).toBe('anthropic')
  })

  it('falls back to defaults — loudly — when the file is not JSON at all', async () => {
    updateSettings(file, { aiProvider: 'anthropic' })
    // A truncated write, as a crash or full disk would leave it.
    writeFileSync(file, '{"aiProvider":"anthr', 'utf8')

    const after = readSettings(file)
    expect(after.aiProvider).toBe('openai')
    expect(console.warn).toHaveBeenCalled()
  })
})

describe('the write is atomic', () => {
  it('leaves no .tmp behind on a successful write', () => {
    updateSettings(file, { aiProvider: 'anthropic' })
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).aiProvider).toBe('anthropic')
  })

  it('never touches the live file when the write itself fails', () => {
    updateSettings(file, { aiProvider: 'anthropic', model: 'claude-sonnet-5' })

    // Force the write to fail by making the temp path unwritable (a directory
    // sits where the .tmp should go) — standing in for the full disk / crash
    // this guards against. With the old direct `writeFileSync(path, …)` the
    // write would simply SUCCEED and replace the live document; with tmp+rename
    // it fails before the live file is ever opened, so the old content survives.
    mkdirSync(`${file}.tmp`, { recursive: true })
    expect(() => updateSettings(file, { aiProvider: 'google' })).toThrow()

    const after = readSettings(file)
    expect(after.aiProvider).toBe('anthropic')
    expect(after.model).toBe('claude-sonnet-5')
  })
})

// ── FEAT-bysdwg: the baseUrl refine must not cost an upgrading user their settings
describe('a settings.json whose baseUrl fails the new validation', () => {
  it('drops only that field and keeps everything else', () => {
    // `Settings.baseUrl` was a bare string for several releases and is now
    // refined (http(s), no credentials/query/fragment). The repair path exists so
    // a newly-stricter field cannot reset a user's whole document on upgrade —
    // the failure mode BUG-yxvrwx was filed for.
    writeFileSync(
      file,
      JSON.stringify({
        ...settingsFixture,
        aiProvider: 'anthropic',
        model: 'claude-opus-5',
        maxClips: 9,
        baseUrl: 'http://user:pw@localhost:11434/?x=1'
      }),
      'utf8'
    )

    const repaired = readSettings(file)

    expect(repaired.baseUrl).toBeUndefined()
    expect(repaired.aiProvider).toBe('anthropic')
    expect(repaired.model).toBe('claude-opus-5')
    expect(repaired.maxClips).toBe(9)
    expect(console.warn).toHaveBeenCalled()
  })

  it('accepts a valid one unchanged, and lets it be cleared', () => {
    updateSettings(file, { baseUrl: 'http://localhost:1234/v1' })
    expect(readSettings(file).baseUrl).toBe('http://localhost:1234/v1')

    // Clearing has to work too — `{...current, ...patch}` only clears the field
    // if an own property with an `undefined` value survives the merge.
    updateSettings(file, { baseUrl: undefined })
    expect(readSettings(file).baseUrl).toBeUndefined()
  })

  it('rejects an invalid one at the write boundary instead of persisting it', () => {
    updateSettings(file, { model: 'keep-me' })
    expect(() => updateSettings(file, { baseUrl: 'javascript:alert(1)' })).toThrow(
      /INPUT_INVALID settings/
    )
    expect(readSettings(file).model).toBe('keep-me')
  })
})
