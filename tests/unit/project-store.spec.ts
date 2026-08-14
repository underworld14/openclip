/**
 * tests/unit/project-store.spec.ts — T-Persist (plan E.3 / P5).
 *
 * `project-store.ts` is PURE JSON I/O over the FROZEN `Project` Zod schema
 * (PRD §9.3, §12.3, §17). These tests run against a REAL temp directory
 * (`fs.mkdtemp`) — no Electron `app` is touched (the store takes its projects
 * dir as a parameter, so `ipc/project.ts` injects `projectsDir()` from
 * trunk-frozen `utils/paths.ts`). Done-when (E.3): save→load deep-equal,
 * Zod re-validate (reject tampered/older files with a typed error), list,
 * delete, and the debounced autosave helper.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  saveProject,
  loadProject,
  listProjects,
  deleteProject,
  createAutosave,
  projectFilePath,
  ProjectStoreError,
  OCPROJ_EXT
} from '@main/services/project-store'
import { Project } from '@shared/schema'
import { projectFixture } from '../fixtures/contract'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openclip-persist-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ── round-trip ────────────────────────────────────────────────────────────
describe('save → load round-trip', () => {
  it('saves to <dir>/<id>.ocproj and loads back DEEP-EQUAL', async () => {
    const { path } = await saveProject(dir, projectFixture)
    expect(path).toBe(join(dir, `${projectFixture.id}${OCPROJ_EXT}`))
    expect(existsSync(path)).toBe(true)

    const loaded = await loadProject(dir, projectFixture.id)
    expect(loaded).toEqual(projectFixture)
  })

  it('PRESERVES unknown future-version keys on load→re-save (forward-compat, openclip-9uq)', async () => {
    // Simulate a .ocproj written by a NEWER app build: extra keys at the top level AND
    // inside a nested object. With plain z.object these were silently STRIPPED on load,
    // so the next autosave permanently dropped them. z.looseObject must keep them.
    const fromNewerBuild = {
      ...projectFixture,
      __futureTopLevel: 'added by a newer version',
      settings: { ...projectFixture.settings, __futureSetting: 42 }
    } as unknown as typeof projectFixture
    await saveProject(dir, fromNewerBuild)

    const loaded = (await loadProject(dir, projectFixture.id)) as unknown as Record<string, unknown>
    expect(loaded.__futureTopLevel).toBe('added by a newer version')
    expect((loaded.settings as Record<string, unknown>).__futureSetting).toBe(42)
    // And the schema itself preserves them (not just the store).
    expect(Project.parse(fromNewerBuild)).toMatchObject({
      __futureTopLevel: 'added by a newer version'
    })
  })

  it('creates the projects directory if it does not exist', async () => {
    const nested = join(dir, 'a', 'b', 'projects')
    expect(existsSync(nested)).toBe(false)
    await saveProject(nested, projectFixture)
    expect(existsSync(nested)).toBe(true)
  })

  it('writes valid, re-parseable COMPACT JSON', async () => {
    const { path } = await saveProject(dir, projectFixture)
    const raw = await readFile(path, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    // COMPACT, not pretty-printed (BUG-g6zq2t): indentation inflated a 2-hour
    // podcast's document by ~39% (3.04 MB → 1.85 MB), paid on every autosave.
    expect(raw).not.toContain('\n  ')
  })

  it('bumps updatedAt on save when touchUpdatedAt is set', async () => {
    const before = Date.now()
    const { project } = await saveProject(dir, projectFixture, { touchUpdatedAt: true })
    expect(project.updatedAt).toBeGreaterThanOrEqual(before)
    const loaded = await loadProject(dir, projectFixture.id)
    expect(loaded.updatedAt).toBe(project.updatedAt)
  })

  it('does NOT mutate the input project object', async () => {
    const snapshot = structuredClone(projectFixture)
    await saveProject(dir, projectFixture, { touchUpdatedAt: true })
    expect(projectFixture).toEqual(snapshot)
  })
})

// ── atomic write (a failed save must not corrupt the prior .ocproj) ──────────
//
// We simulate a write that fails AFTER the temp file is created (e.g. a rename
// that fails with EXDEV/ENOSPC) by making the destination path un-renamable-to:
// pre-creating a non-empty DIRECTORY at the `.ocproj` path forces `rename(tmp,
// dest)` to fail with ENOTEMPTY/EISDIR on every platform — no fs mocking, which
// ESM module namespaces forbid. The prior good file is a separate save.
describe('saveProject is atomic (temp file + rename)', () => {
  it('leaves the prior .ocproj INTACT when the rename fails mid-save', async () => {
    // Seed a known-good previous save under one id.
    const goodId = '22222222-2222-4222-8222-222222222222'
    const v1 = { ...projectFixture, id: goodId, name: 'GOOD v1' }
    const { path: goodPath } = await saveProject(dir, v1)
    const before = await readFile(goodPath, 'utf8')
    expect(JSON.parse(before).name).toBe('GOOD v1')

    // For the FAILING save, make its destination a non-empty directory so the
    // final `rename(tmp, dest)` fails — the temp write succeeds, the publish does
    // not. The prior good file (different id) must be untouched.
    const badId = '33333333-3333-4333-8333-333333333333'
    const badDest = join(dir, `${badId}${OCPROJ_EXT}`)
    await mkdir(badDest, { recursive: true })
    await writeFile(join(badDest, 'keep'), 'x', 'utf8') // make it non-empty → ENOTEMPTY

    const v2 = { ...projectFixture, id: badId, name: 'BAD v2' }
    await expect(saveProject(dir, v2)).rejects.toMatchObject({ code: 'IO' })

    // The pre-existing good file survives, byte-for-byte.
    const after = await readFile(goodPath, 'utf8')
    expect(after).toBe(before)
    const loaded = await loadProject(dir, goodId)
    expect(loaded.name).toBe('GOOD v1')
  })

  it('does not leave a leftover temp file behind on a failed write', async () => {
    const badId = '44444444-4444-4444-8444-444444444444'
    const badDest = join(dir, `${badId}${OCPROJ_EXT}`)
    await mkdir(badDest, { recursive: true })
    await writeFile(join(badDest, 'keep'), 'x', 'utf8')

    await expect(saveProject(dir, { ...projectFixture, id: badId })).rejects.toMatchObject({
      code: 'IO'
    })
    // No `.tmp` scratch file should be left behind (best-effort cleanup).
    const leftovers = (await readdir(dir)).filter((n) => n.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})

// ── Zod re-validation on load (PRD §12.3 reject tampered/older files) ────────
describe('load re-validates with the Project Zod schema', () => {
  it('rejects a tampered file (wrong field type) with a typed VALIDATION error', async () => {
    const path = projectFilePath(dir, projectFixture.id)
    await mkdir(dir, { recursive: true })
    // duration must be a number — tamper it to a string.
    const tampered = {
      ...projectFixture,
      sourceVideo: { ...projectFixture.sourceVideo, duration: 'nope' }
    }
    await writeFile(path, JSON.stringify(tampered), 'utf8')

    await expect(loadProject(dir, projectFixture.id)).rejects.toBeInstanceOf(ProjectStoreError)
    await expect(loadProject(dir, projectFixture.id)).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('rejects a file missing a required field with a typed VALIDATION error', async () => {
    const path = projectFilePath(dir, projectFixture.id)
    await mkdir(dir, { recursive: true })
    const { clips: _drop, ...withoutClips } = projectFixture
    void _drop
    await writeFile(path, JSON.stringify(withoutClips), 'utf8')
    await expect(loadProject(dir, projectFixture.id)).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('rejects malformed JSON with a typed PARSE error', async () => {
    const path = projectFilePath(dir, projectFixture.id)
    await mkdir(dir, { recursive: true })
    await writeFile(path, '{ this is not json', 'utf8')
    await expect(loadProject(dir, projectFixture.id)).rejects.toMatchObject({ code: 'PARSE' })
  })

  it('rejects a missing project with a typed NOT_FOUND error', async () => {
    await expect(loadProject(dir, 'does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('a freshly saved file always re-validates (round-trip is schema-stable)', async () => {
    await saveProject(dir, projectFixture)
    const path = projectFilePath(dir, projectFixture.id)
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    expect(() => Project.parse(onDisk)).not.toThrow()
  })
})

// ── list ────────────────────────────────────────────────────────────────────
describe('listProjects', () => {
  it('lists saved projects as {id,name,updatedAt,path}, newest first', async () => {
    const older = { ...projectFixture, id: 'aaa', name: 'Older', updatedAt: 1000 }
    const newer = { ...projectFixture, id: 'bbb', name: 'Newer', updatedAt: 5000 }
    await saveProject(dir, older)
    await saveProject(dir, newer)

    const list = await listProjects(dir)
    expect(list).toHaveLength(2)
    expect(list.map((p) => p.id)).toEqual(['bbb', 'aaa']) // newest first
    expect(list[0]).toEqual({
      id: 'bbb',
      name: 'Newer',
      updatedAt: 5000,
      path: join(dir, `bbb${OCPROJ_EXT}`)
    })
  })

  it('returns [] when the projects dir does not exist (first run)', async () => {
    const missing = join(dir, 'never-created')
    expect(await listProjects(missing)).toEqual([])
  })

  it('ignores non-.ocproj files and unparseable .ocproj files (resilient list)', async () => {
    await saveProject(dir, projectFixture)
    await writeFile(join(dir, 'notes.txt'), 'hello', 'utf8')
    await writeFile(join(dir, 'broken.ocproj'), '{ broken', 'utf8')
    const list = await listProjects(dir)
    expect(list.map((p) => p.id)).toEqual([projectFixture.id])
  })
})

// ── delete ────────────────────────────────────────────────────────────────
describe('deleteProject', () => {
  it('deletes an existing project file and reports deleted:true', async () => {
    const { path } = await saveProject(dir, projectFixture)
    expect(existsSync(path)).toBe(true)
    const res = await deleteProject(dir, projectFixture.id)
    expect(res).toEqual({ deleted: true })
    expect(existsSync(path)).toBe(false)
  })

  it('reports deleted:false for a non-existent project (idempotent)', async () => {
    expect(await deleteProject(dir, 'nope')).toEqual({ deleted: false })
  })
})

// ── autosave debounce (E.3 done-when) ───────────────────────────────────────
describe('createAutosave (debounced)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces rapid calls into a single save after the quiet window', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const autosave = createAutosave(save, 500)

    autosave(projectFixture)
    autosave(projectFixture)
    autosave(projectFixture)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(499)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    // saves the LATEST snapshot passed
    expect(save).toHaveBeenLastCalledWith(projectFixture)
  })

  it('saves the latest project when multiple distinct snapshots are queued', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const autosave = createAutosave(save, 300)
    const v1 = { ...projectFixture, name: 'v1' }
    const v2 = { ...projectFixture, name: 'v2' }
    autosave(v1)
    autosave(v2)
    await vi.advanceTimersByTimeAsync(300)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(v2)
  })

  it('schedules a fresh save after a previous one fired (independent windows)', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const autosave = createAutosave(save, 200)
    autosave(projectFixture)
    await vi.advanceTimersByTimeAsync(200)
    expect(save).toHaveBeenCalledTimes(1)

    autosave(projectFixture)
    await vi.advanceTimersByTimeAsync(200)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('flush() saves immediately and cancels the pending timer', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const autosave = createAutosave(save, 1000)
    autosave(projectFixture)
    await autosave.flush()
    expect(save).toHaveBeenCalledTimes(1)
    // the pending timer must not fire a second save
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush() is a no-op when nothing is pending', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const autosave = createAutosave(save, 1000)
    await autosave.flush()
    expect(save).not.toHaveBeenCalled()
  })

  it('serializes overlapping saves — a new save waits for the in-flight one (openclip-9lf)', async () => {
    const order: string[] = []
    let releaseV1 = (): void => {}
    const save = vi.fn((p: { name: string }): Promise<void> => {
      order.push(`start:${p.name}`)
      if (p.name === 'v1') {
        return new Promise<void>((resolve) => {
          releaseV1 = (): void => {
            order.push('end:v1')
            resolve()
          }
        })
      }
      order.push('end:v2')
      return Promise.resolve()
    })
    const autosave = createAutosave(save as never, 100)

    autosave({ name: 'v1' } as never)
    await vi.advanceTimersByTimeAsync(100) // fire → save(v1) starts, stays in-flight
    expect(order).toEqual(['start:v1'])

    autosave({ name: 'v2' } as never)
    await vi.advanceTimersByTimeAsync(100) // fire → save(v2) must NOT start until v1 ends
    expect(order).toEqual(['start:v1']) // not interleaved against the in-flight write

    releaseV1()
    await vi.advanceTimersByTimeAsync(0) // let the chain drain
    expect(order).toEqual(['start:v1', 'end:v1', 'start:v2', 'end:v2'])
  })

  it('a rejected save does not throw out of the debounced call nor wedge later saves (openclip-9lf)', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const autosave = createAutosave(save, 100)

    autosave(projectFixture)
    await vi.advanceTimersByTimeAsync(100) // first save REJECTS — swallowed, no unhandled rejection
    expect(save).toHaveBeenCalledTimes(1)

    autosave(projectFixture)
    await vi.advanceTimersByTimeAsync(100) // a later save still runs (chain not wedged)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('cancel() drops a pending save', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const autosave = createAutosave(save, 500)
    autosave(projectFixture)
    autosave.cancel()
    await vi.advanceTimersByTimeAsync(500)
    expect(save).not.toHaveBeenCalled()
  })
})
