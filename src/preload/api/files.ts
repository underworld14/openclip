/**
 * preload/api/files.ts — `window.openclip.files` (FEAT-hmsg5h).
 *
 * The one bridge namespace NOT derived from `ChannelMap`, because it is not IPC:
 * `webUtils.getPathForFile` is a renderer-side Electron call that resolves a
 * dropped `File` to its absolute path. Electron removed the old `File.path`
 * property, so this is the only supported way to accept a drag-and-dropped video
 * — and drag-and-drop is advertised in the Welcome copy and is the first
 * acceptance criterion of PRD §6.1.
 *
 * `jobs` is the other hand-written namespace, for the same reason: a MessagePort
 * cannot ride `invoke` either.
 */

import { webUtils } from 'electron'

export interface FilesAPI {
  /** Absolute path of a dropped/selected File. Empty string when unavailable. */
  getPathForFile(file: File): string
}

export function buildFilesApi(): FilesAPI {
  return {
    getPathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        // A File that did not come from the filesystem (e.g. a synthetic one in a
        // test harness) has no path; an empty string lets the caller reject it
        // with a message instead of crashing the drop handler.
        return ''
      }
    }
  }
}
