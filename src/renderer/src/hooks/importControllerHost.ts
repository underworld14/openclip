/**
 * importControllerHost — module-level state shared by every `useImportController`
 * caller.
 *
 * The import controller is a singleton (it has to be: ImportPanel unmounts
 * partway through a first-run import, so a per-component instance took the
 * in-flight progress, cancel and error state with it). That created a subtler
 * problem: the singleton also baked in the `onNeedModel` callback of whichever
 * component happened to construct it FIRST. React runs a parent's hooks before
 * its children's, so `App` — which passed no callback — always won, and the
 * whisper-model dialog stopped opening at all.
 *
 * So the callback lives here instead of inside the controller's closure, and is
 * resolved at call time. Framework-free so it is testable in the node env.
 */

import type { WhisperModelSize } from '@shared/jobs'

type NeedModelHandler = (model: WhisperModelSize) => void

let handler: NeedModelHandler | undefined

/**
 * Register the handler that opens the model-download dialog.
 *
 * An `undefined` registration is IGNORED rather than clearing the slot: callers
 * that don't supply one must not be able to clobber a caller that does, which is
 * exactly how the original bug happened.
 */
export function setNeedModelHandler(fn: NeedModelHandler | undefined): void {
  if (fn) handler = fn
}

/** Ask the UI to open the model-download dialog. No-op when nothing is wired. */
export function notifyNeedModel(model: WhisperModelSize): void {
  handler?.(model)
}

/** TEST-ONLY: clear the registry so specs start from a clean slate. */
export function __resetImportHostForTests(): void {
  handler = undefined
}
