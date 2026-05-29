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
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
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

  it('creates the projects directory if it does not exist', async () => {
    const nested = join(dir, 'a', 'b', 'projects')
    expect(existsSync(nested)).toBe(false)
    await saveProject(nested, projectFixture)
    expect(existsSync(nested)).toBe(true)
  })

  it('writes valid, re-parseable JSON (pretty-printed)', async () => {
    const { path } = await saveProject(dir, projectFixture)
    const raw = await readFile(path, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    // pretty-printed (2-space) for human-readable backup/sharing (PRD §6.9)
    expect(raw).toContain('\n  ')
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

  it('cancel() drops a pending save', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const autosave = createAutosave(save, 500)
    autosave(projectFixture)
    autosave.cancel()
    await vi.advanceTimersByTimeAsync(500)
    expect(save).not.toHaveBeenCalled()
  })
})
