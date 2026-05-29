/**
 * src/shared/autosave.ts — process-agnostic trailing-edge debounce for autosave
 * (Wave-1 integration relocation).
 *
 * T-Persist authored `createAutosave` inside `src/main/services/project-store.ts`
 * with the documented intent of being "a debounced save helper FOR THE RENDERER'S
 * autosave loop" — but the renderer cannot import from `src/main` (process-isolation
 * lint rule, plan E.4/E.7). The helper is pure timer logic with zero node/main
 * dependencies, so at integration it moves down into the shared leaf where BOTH
 * processes may import it. `project-store.ts` re-exports it for backward compat;
 * the renderer's autosave subscriber (`stores/projectStore/autosave.ts`) consumes
 * it directly.
 *
 * Behaviour (unchanged from the original; covered by `project-store.spec.ts`):
 * rapid calls within `delayMs` coalesce into a SINGLE save of the LATEST payload
 * once the stream goes quiet (trailing edge). `flush()` saves the pending payload
 * immediately and clears the timer; `cancel()` drops a pending save with no write.
 */

/** Default autosave quiet window (ms) before a coalesced save fires. */
export const DEFAULT_AUTOSAVE_DELAY_MS = 800 as const

/** A debounced autosave callable: invoke with the latest payload to schedule a save. */
export interface Autosave<T> {
  (payload: T): void
  /** Save the pending payload immediately and cancel the pending timer. */
  flush(): Promise<void>
  /** Drop any pending save without writing. */
  cancel(): void
}

/**
 * Wrap a `save(payload)` callback in a trailing-edge debounce: rapid calls within
 * `delayMs` coalesce into a SINGLE save of the LATEST payload once the stream goes
 * quiet. Independent of the filesystem and of any process — the main side pipes a
 * filesystem write; the renderer pipes its bridge `save()`; unit tests pass a spy.
 */
export function createAutosave<T>(
  save: (payload: T) => Promise<void> | void,
  delayMs: number = DEFAULT_AUTOSAVE_DELAY_MS
): Autosave<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: T | null = null
  let hasPending = false

  const fire = async (): Promise<void> => {
    timer = null
    if (!hasPending) return
    const snapshot = pending as T
    pending = null
    hasPending = false
    await save(snapshot)
  }

  const autosave = ((payload: T): void => {
    pending = payload
    hasPending = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void fire(), delayMs)
  }) as Autosave<T>

  autosave.flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    await fire()
  }

  autosave.cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
    hasPending = false
  }

  return autosave
}
