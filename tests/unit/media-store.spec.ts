/**
 * tests/unit/media-store.spec.ts — the persistent media store (Part H), against a
 * REAL temp filesystem (mirrors project-store.spec). Covers adopt (move + the
 * EXDEV copy+unlink fallback), per-project delete, the orphan sweep, and the
 * projectId path-injection guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
// Partially mock fs/promises so `rename` is interceptable (to force EXDEV); every
// other fn delegates to the real implementation against a temp dir.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof FsPromises>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
import { mkdtemp, mkdir, rm, writeFile, readFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptIntoMedia,
  deleteProjectMedia,
  sweepOrphanMedia,
  projectMediaDir,
  assertSafeProjectId,
  MediaStoreError
} from '@main/services/media-store'

let root: string // media root
let work: string // a scratch dir for "downloads"

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'oc-media-'))
  work = await mkdtemp(join(tmpdir(), 'oc-work-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('assertSafeProjectId', () => {
  it('accepts a plain id, rejects separators / .. / empty', () => {
    expect(assertSafeProjectId('p1')).toBe('p1')
    expect(() => assertSafeProjectId('../escape')).toThrow(MediaStoreError)
    expect(() => assertSafeProjectId('a/b')).toThrow(MediaStoreError)
    expect(() => assertSafeProjectId('')).toThrow(MediaStoreError)
  })
})

describe('adoptIntoMedia', () => {
  it('moves the file into media/<projectId>/<basename> and removes the source', async () => {
    const src = join(work, 'video.mp4')
    await writeFile(src, 'DATA')
    const dest = await adoptIntoMedia(src, 'proj1', root)
    expect(dest).toBe(join(root, 'proj1', 'video.mp4'))
    expect(await readFile(dest, 'utf8')).toBe('DATA')
    expect(existsSync(src)).toBe(false) // source moved away
  })

  it('falls back to copy+unlink on a cross-volume EXDEV rename', async () => {
    const src = join(work, 'video.mp4')
    await writeFile(src, 'DATA')
    // Force the first rename to fail with EXDEV so the copy+unlink path runs.
    vi.mocked(rename).mockImplementationOnce(async () => {
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
    })
    const dest = await adoptIntoMedia(src, 'proj1', root)
    expect(vi.mocked(rename)).toHaveBeenCalled()
    expect(await readFile(dest, 'utf8')).toBe('DATA') // copied through
    expect(existsSync(src)).toBe(false) // source unlinked
  })

  it('rejects an unsafe projectId before touching the fs', async () => {
    const src = join(work, 'v.mp4')
    await writeFile(src, 'x')
    await expect(adoptIntoMedia(src, '../evil', root)).rejects.toThrow(MediaStoreError)
  })

  it('rejects a source whose basename is .. / . (dest-escape guard)', async () => {
    await expect(adoptIntoMedia(join(work, '..'), 'p1', root)).rejects.toThrow(MediaStoreError)
  })
})

describe('deleteProjectMedia', () => {
  it('removes only media/<projectId>/ and is idempotent', async () => {
    const dir = projectMediaDir(root, 'proj1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'v.mp4'), 'x')
    expect((await deleteProjectMedia('proj1', root)).deleted).toBe(true)
    expect(existsSync(dir)).toBe(false)
    // Idempotent: a second delete on a missing dir still resolves.
    expect((await deleteProjectMedia('proj1', root)).deleted).toBe(true)
  })
})

describe('sweepOrphanMedia', () => {
  it('removes unreferenced subdirs, keeps referenced ones, no-ops on a missing root', async () => {
    await mkdir(join(root, 'keep'), { recursive: true })
    await mkdir(join(root, 'orphan-a'), { recursive: true })
    await mkdir(join(root, 'orphan-b'), { recursive: true })
    const { removed } = await sweepOrphanMedia(['keep'], root)
    expect(removed.sort()).toEqual(['orphan-a', 'orphan-b'])
    expect(existsSync(join(root, 'keep'))).toBe(true)
    expect(existsSync(join(root, 'orphan-a'))).toBe(false)

    const missing = join(tmpdir(), 'oc-media-does-not-exist-xyz')
    expect((await sweepOrphanMedia(['k'], missing)).removed).toEqual([])
  })
})
