/**
 * src/main/services/project-store.ts — `.ocproj` persistence (T-Persist, P5).
 *
 * PURE JSON I/O over the FROZEN `Project` Zod schema (PRD §9.3, §12.3 "project +
 * transcript stored locally as `.ocproj` JSON", plan E.3). The projects
 * directory is a PARAMETER — never resolved here — so this module is fully
 * unit-testable against a real temp dir with NO Electron `app` import. The IPC
 * layer (`ipc/project.ts`) injects `projectsDir()` from trunk-frozen
 * `utils/paths.ts` (which is the only place `app.getPath('userData')` lives).
 *
 * Responsibilities:
 *   - saveProject  — serialize a Project → `<dir>/<id>.ocproj` (pretty JSON).
 *   - loadProject  — read + JSON.parse + RE-VALIDATE with `Project` Zod
 *     (rejects tampered / older / malformed files with a typed error — §12.3).
 *   - listProjects — enumerate `.ocproj` docs as lightweight metadata, newest
 *     first (drives the Dashboard recent-projects list — PRD §11.2).
 *   - deleteProject — remove a `.ocproj` file (idempotent).
 *   - createAutosave — a debounced save helper for the renderer's autosave loop.
 *
 * Every failure path surfaces a typed `ProjectStoreError` so callers (and the
 * IPC boundary) can branch on `.code` instead of string-matching messages.
 */

import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Project } from '@shared/schema'
import type { Project as ProjectType } from '@shared/schema'
// Wave-1 integration: the pure autosave debounce moved to the shared leaf so the
// renderer can consume it too (it could not import from src/main). Re-exported
// here for backward compatibility with the main-side callers/tests.
import {
  createAutosave as createAutosaveImpl,
  DEFAULT_AUTOSAVE_DELAY_MS,
  type Autosave as AutosaveGeneric
} from '@shared/autosave'

/** Canonical OpenClip project file extension (PRD §6.9 "Export project file"). */
export const OCPROJ_EXT = '.ocproj' as const

export { DEFAULT_AUTOSAVE_DELAY_MS }

// ============================================================================
// Typed errors — callers branch on `.code`, never on message strings.
// ============================================================================

export type ProjectStoreErrorCode = 'NOT_FOUND' | 'PARSE' | 'VALIDATION' | 'IO'

/** A typed persistence failure (PRD §12.3 reject tampered/older `.ocproj`). */
export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode
  /** The underlying cause (a ZodError, a SyntaxError, or an fs error). */
  override readonly cause?: unknown

  constructor(code: ProjectStoreErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'ProjectStoreError'
    this.code = code
    this.cause = cause
  }
}

// ============================================================================
// Path helpers (pure — directory is always injected)
// ============================================================================

/** Absolute path to a project's `.ocproj` file inside `dir`. */
export function projectFilePath(dir: string, id: string): string {
  return join(dir, `${id}${OCPROJ_EXT}`)
}

// ============================================================================
// Save / load
// ============================================================================

export interface SaveOptions {
  /** Stamp `updatedAt` to `Date.now()` before writing (autosave / explicit save). */
  touchUpdatedAt?: boolean
}

export interface SaveResult {
  /** Absolute path the `.ocproj` was written to (the SAVE_PROJECT res shape). */
  path: string
  /** The project as persisted (with any `updatedAt` bump applied). */
  project: ProjectType
}

/**
 * Serialize a Project to `<dir>/<id>.ocproj` as pretty-printed JSON. Creates the
 * directory tree if missing. Does NOT mutate the input project. When
 * `touchUpdatedAt` is set, the persisted copy gets a fresh `updatedAt` (PRD §9.3).
 */
export async function saveProject(
  dir: string,
  project: ProjectType,
  opts: SaveOptions = {}
): Promise<SaveResult> {
  const toPersist: ProjectType = opts.touchUpdatedAt
    ? { ...project, updatedAt: Date.now() }
    : project
  const path = projectFilePath(dir, toPersist.id)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, JSON.stringify(toPersist, null, 2), 'utf8')
  } catch (cause) {
    throw new ProjectStoreError('IO', `failed to write project ${toPersist.id}`, cause)
  }
  return { path, project: toPersist }
}

/**
 * Read + JSON.parse + RE-VALIDATE a `.ocproj` against the frozen `Project` Zod
 * schema. Rejects with a typed `ProjectStoreError`:
 *   - NOT_FOUND   — no file for `id`.
 *   - PARSE       — file is not valid JSON.
 *   - VALIDATION  — JSON does not satisfy the `Project` schema (tampered/older).
 *   - IO          — any other read failure.
 */
export async function loadProject(dir: string, id: string): Promise<ProjectType> {
  const path = projectFilePath(dir, id)

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (cause) {
    if (isNotFound(cause)) {
      throw new ProjectStoreError('NOT_FOUND', `no project ${id} at ${path}`, cause)
    }
    throw new ProjectStoreError('IO', `failed to read project ${id}`, cause)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (cause) {
    throw new ProjectStoreError('PARSE', `project ${id} is not valid JSON`, cause)
  }

  const result = Project.safeParse(json)
  if (!result.success) {
    throw new ProjectStoreError(
      'VALIDATION',
      `project ${id} failed schema validation (tampered or unsupported version)`,
      result.error
    )
  }
  return result.data
}

// ============================================================================
// List / delete
// ============================================================================

/** Lightweight project metadata for the Dashboard recents (LIST_PROJECTS res). */
export interface ProjectListEntry {
  id: string
  name: string
  updatedAt: number
  path: string
}

/**
 * Enumerate `.ocproj` documents in `dir` as lightweight metadata, NEWEST FIRST.
 * Resilient: a missing directory yields `[]` (first run); non-`.ocproj` files and
 * individually-unparseable/invalid `.ocproj` files are skipped (a corrupt file
 * must not break the whole dashboard list — PRD §11.2).
 */
export async function listProjects(dir: string): Promise<ProjectListEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (cause) {
    if (isNotFound(cause)) return []
    throw new ProjectStoreError('IO', `failed to list projects in ${dir}`, cause)
  }

  const entries: ProjectListEntry[] = []
  for (const name of names) {
    if (!name.endsWith(OCPROJ_EXT)) continue
    const path = join(dir, name)
    try {
      const json = JSON.parse(await readFile(path, 'utf8'))
      // Minimal validation: we only need id/name/updatedAt for the list. A fuller
      // re-validation happens on actual `loadProject`. Skip anything malformed.
      const parsed = Project.safeParse(json)
      if (!parsed.success) continue
      const p = parsed.data
      entries.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, path })
    } catch {
      continue // unparseable file — skip, don't fail the whole list
    }
  }

  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  return entries
}

/** Delete a `.ocproj` file. Idempotent: reports `deleted:false` if absent. */
export async function deleteProject(dir: string, id: string): Promise<{ deleted: boolean }> {
  const path = projectFilePath(dir, id)
  try {
    await stat(path)
  } catch (cause) {
    if (isNotFound(cause)) return { deleted: false }
    throw new ProjectStoreError('IO', `failed to stat project ${id}`, cause)
  }
  try {
    await rm(path, { force: false })
  } catch (cause) {
    throw new ProjectStoreError('IO', `failed to delete project ${id}`, cause)
  }
  return { deleted: true }
}

// ============================================================================
// Debounced autosave helper (E.3 done-when: "autosave debounce tested")
//
// The implementation lives in `@shared/autosave` (Wave-1 integration relocation
// — see that file's header). These aliases keep the `Project`-specialized public
// surface that main-side callers/tests depend on.
// ============================================================================

/** A debounced autosave callable: invoke with the latest project to schedule a save. */
export type Autosave = AutosaveGeneric<ProjectType>

/**
 * Wrap a `save(project)` callback in a trailing-edge debounce (see
 * `@shared/autosave#createAutosave`). Rapid calls within `delayMs` coalesce into
 * a SINGLE save of the LATEST project once the stream goes quiet.
 */
export function createAutosave(
  save: (project: ProjectType) => Promise<void> | void,
  delayMs: number = DEFAULT_AUTOSAVE_DELAY_MS
): Autosave {
  return createAutosaveImpl<ProjectType>(save, delayMs)
}

// ============================================================================
// internal
// ============================================================================

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
