/**
 * src/preload/menu-command.ts — forward application-menu commands into the
 * renderer's MAIN world as a window message (FEAT-vvaycm).
 *
 * Same shape as `quit-flush.ts`: contextIsolation means the renderer cannot
 * listen on `ipcRenderer`, so a one-way main→renderer signal is re-posted as a
 * `window.postMessage` the renderer subscribes to.
 *
 * The payload is a `ShortcutId` from the shared table — the menu item, the
 * keyboard hook and the help sheet all name the same action.
 */

import { ipcRenderer } from 'electron'
import { IPCChannels } from '@shared/channels'
import type { ShortcutId } from '@shared/shortcuts'

/** The `window.postMessage` tag the renderer's shortcut hook listens for. */
export const MENU_COMMAND_MESSAGE = 'openclip:menu-command' as const

export interface MenuCommandMessage {
  __openclip: typeof MENU_COMMAND_MESSAGE
  id: ShortcutId
}

let installed = false
export function installMenuCommandForwarder(): void {
  if (installed) return
  installed = true
  ipcRenderer.on(IPCChannels.MENU_COMMAND, (_e, id: ShortcutId) => {
    window.postMessage({ __openclip: MENU_COMMAND_MESSAGE, id } satisfies MenuCommandMessage, '*')
  })
}
