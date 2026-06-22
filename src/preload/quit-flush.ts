/**
 * src/preload/quit-flush.ts — forward the main-process `FLUSH_BEFORE_QUIT` signal into
 * the renderer's MAIN world as a window message (audit fix openclip-49y).
 *
 * On `before-quit` the main process sends `system:flush-before-quit`; contextIsolation
 * means the renderer can't listen on `ipcRenderer` directly, so (exactly like the JOB_PORT
 * forwarder) we re-post it as a `window.postMessage` the renderer's autosave installer can
 * subscribe to. The renderer flushes its pending debounced save and then calls
 * `window.openclip.system.autosaveFlushed()` so main can quit the instant the save lands.
 */

import { ipcRenderer } from 'electron'
import { IPCChannels } from '@shared/channels'

/** The `window.postMessage` tag the renderer's autosave listens for. */
export const QUIT_FLUSH_MESSAGE = 'openclip:flush-before-quit' as const

let installed = false
export function installQuitFlushForwarder(): void {
  if (installed) return
  installed = true
  ipcRenderer.on(IPCChannels.FLUSH_BEFORE_QUIT, () => {
    window.postMessage({ __openclip: QUIT_FLUSH_MESSAGE }, '*')
  })
}
