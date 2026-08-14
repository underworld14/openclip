/**
 * src/shared/ipc-errors.ts — the control plane's error convention, made
 * branchable (FEAT-azqfsv, deferred from FEAT-et1gxc).
 *
 * THE CONSTRAINT. `ipcMain.handle` FLATTENS a rejection to its message string on
 * the way across IPC: a thrown `JobError` arrives in the renderer as a plain
 * `Error` whose `.code` is gone. (The job plane sidesteps this by carrying `code`
 * as a FIELD of the `{t:'error'}` event, which is data, not an exception —
 * `job-start-validation.ts` repeats the code into the message for exactly this
 * reason.) So a typed error class cannot survive the control plane, and the code
 * has to travel in the only thing that does: the text.
 *
 * FEAT-et1gxc asked for a typed error "so callers can branch". The prefix is the
 * pragmatic answer, but leaving it at that pushes the branching into ad-hoc
 * `String(e).includes('NOT_IMPLEMENTED')` at every call site — which is the exact
 * fragility typed errors exist to avoid, just relocated.
 *
 * So: ONE convention, and ONE predicate. Handlers build the message with
 * `notImplemented()`; callers branch with `isNotImplemented(err)`. The string
 * shape lives in this file and nowhere else, so tightening it later is a
 * one-file change rather than a grep.
 */

/** The prefix that survives `ipcMain.handle`'s flattening to a message string. */
export const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED'

/**
 * Build a rejection for a control-plane handler that is not built yet.
 *
 * Rejecting beats answering with an empty success: `{options: []}` is
 * indistinguishable from "the model had no suggestions", so a caller cannot
 * branch on it and a UI built against it renders nothing, forever, silently
 * (the original FEAT-et1gxc finding).
 */
export function notImplemented(detail: string): Error {
  return new Error(`${NOT_IMPLEMENTED}: ${detail}`)
}

/**
 * Is this rejection a not-yet-built handler?
 *
 * Takes `unknown` because that is what a `catch` binding is, and because the
 * value arriving from the bridge is an `Error` in some paths and a bare string
 * in others depending on how it was serialised.
 */
export function isNotImplemented(err: unknown): boolean {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return text.includes(NOT_IMPLEMENTED)
}
