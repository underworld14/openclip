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

import { readFile, writeFile, mkdir, readdir, rm, stat, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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

/**
 * A project id must be a single path segment (no separators / `..` / NUL) —
 * trust boundary: `id` reaches here from the renderer over IPC (SAVE_PROJECT /
 * LOAD_PROJECT / DELETE_PROJECT — BUG-hqbett). Mirrors `assertSafeProjectId` in
 * `paths.ts`/`media-store.ts` — duplicated rather than imported so this module
 * stays Electron-free (its own header's documented testability property).
 */
function assertSafeProjectId(id: string): string {
  if (!id || /[\\/]/.test(id) || id === '.' || id === '..' || id.includes('\0')) {
    throw new ProjectStoreError('VALIDATION', `unsafe project id: ${JSON.stringify(id)}`)
  }
  return id
}

/** Absolute path to a project's `.ocproj` file inside `dir`. */
export function projectFilePath(dir: string, id: string): string {
  return join(dir, `${assertSafeProjectId(id)}${OCPROJ_EXT}`)
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
 * Serialize a Project to `<dir>/<id>.ocproj` as compact JSON. Creates the
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
  // Atomic write: serialize to a sibling temp file, then `rename` it over the
  // destination. `rename` is atomic on the same filesystem, so a crash or error
  // mid-write can never leave a half-written `.ocproj` (the prior good file
  // survives untouched). The temp lives in the SAME dir to guarantee same-FS. A
  // random suffix keeps concurrent saves of the same project (autosave + a manual
  // save, or a pagehide flush) from colliding on one temp path.
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(dir, { recursive: true })
    // COMPACT, not pretty-printed (BUG-g6zq2t). A 2-hour podcast's `.ocproj` is
    // dominated by ~20,000 word timestamps, and two-space indentation inflated it
    // by ~39% (3.04 MB → 1.85 MB measured) — paid on every autosave, which fires
    // on every approve, reject and settled trim drag. `loadProject` is unaffected;
    // the cost is that the file is no longer pleasant to read by hand, which is
    // not what it is for.
    await writeFile(tmp, JSON.stringify(toPersist), 'utf8')
    await rename(tmp, path)
  } catch (cause) {
    // Best-effort cleanup of the orphaned temp file; swallow its own errors.
    await rm(tmp, { force: true }).catch(() => {})
    throw new ProjectStoreError('IO', `failed to write project ${toPersist.id}`, cause)
  }
  return { path, project: toPersist }
}

/**
 * Persist ONLY the fields that changed, leaving the rest of the document — above
 * all `transcript.words` — untouched on disk (BUG-g6zq2t).
 *
 * Autosave fires on every approve, reject and settled trim drag. `saveProject`
 * ships the entire document each time, so a 2-hour podcast wrote 1.85 MB
 * (including ~20,000 word timestamps) to persist a few hundred bytes of clip
 * state; a 30-edit session wrote ~90 MB. This reads the on-disk doc, merges the
 * patch and writes it back through the same atomic path, so the renderer never
 * has to hand the transcript across the contextBridge at all.
 *
 * Re-validates after merging: a patch is renderer-supplied, and a merge that
 * produced an invalid document would otherwise be discovered at load time, long
 * after the state that caused it is gone.
 */
export async function patchProject(
  dir: string,
  patch: {
    id: string
    clips?: ProjectType['clips']
    exportHistory?: ProjectType['exportHistory']
    settings?: ProjectType['settings']
    name?: string
  },
  opts: { touchUpdatedAt?: boolean } = {}
): Promise<SaveResult> {
  const current = await loadProject(dir, patch.id)
  const merged: ProjectType = {
    ...current,
    ...(patch.clips !== undefined ? { clips: patch.clips } : {}),
    ...(patch.exportHistory !== undefined ? { exportHistory: patch.exportHistory } : {}),
    ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
    ...(patch.name !== undefined ? { name: patch.name } : {})
  }
  const parsed = Project.safeParse(merged)
  if (!parsed.success) {
    throw new ProjectStoreError(
      'VALIDATION',
      `patch produced an invalid project ${patch.id}: ${parsed.error.message}`
    )
  }
  return saveProject(dir, parsed.data, opts)
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
      // The recents list only needs id/name/updatedAt, so we SHALLOW-validate those
      // three fields rather than running the full `Project.safeParse` over the entire
      // document (audit fix openclip-p0l): a long video's `.ocproj` embeds thousands
      // of word timestamps + segments + clips, and fully validating every file just to
      // render a name + date made the Dashboard mount O(total transcript size). The
      // authoritative full re-validation still happens on `loadProject` when opened.
      const json = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      if (
        typeof json.id === 'string' &&
        typeof json.name === 'string' &&
        typeof json.updatedAt === 'number'
      ) {
        entries.push({ id: json.id, name: json.name, updatedAt: json.updatedAt, path })
      }
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
