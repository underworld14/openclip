/**
 * src/main/menu.ts — the macOS application menu (FEAT-vvaycm).
 *
 * `setApplicationMenu` appeared NOWHERE in `src/main`, so the app ran on
 * Electron's stock menu: no Cmd+N, no Cmd+O, no Cmd+I, no Cmd+E, no Cmd+,. The
 * only key handling in the whole app was three keys on a `<div>` that had to hold
 * focus first, with the key list buried in an `aria-label`.
 *
 * A menu is not decoration here — it is the DISCOVERY surface. A shortcut nobody
 * can find is a shortcut nobody uses, and the menu bar is where a Mac user looks.
 *
 * Items are built from `@shared/shortcuts`, the same table the renderer's keydown
 * hook and the `?` sheet read, so a menu item and its key cannot disagree. Items
 * whose `accelerator` is null still appear — with the key shown in the label —
 * because a bare letter bound as a menu accelerator is captured globally and
 * could never reach a focused text field.
 *
 * Commands travel to the renderer over the ONE-WAY `lifecycle:menu-command`
 * channel, the same trick `FLUSH_BEFORE_QUIT` uses: the `lifecycle:` prefix keeps
 * `buildNamespace('system')` from auto-exposing it as an invoke, because it isn't
 * one.
 */

import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPCChannels } from '@shared/channels'
import { shortcutsForMenu, type Shortcut, type ShortcutId } from '@shared/shortcuts'

/** Send a menu command to the focused window's renderer. */
function send(win: BrowserWindow | null, id: ShortcutId): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPCChannels.MENU_COMMAND, id)
}

/**
 * One menu item for a shortcut.
 *
 * A null accelerator still yields an item: the label carries the key as text so
 * the shortcut stays DISCOVERABLE, while the renderer's focus-aware hook remains
 * the thing that actually fires it.
 */
function itemFor(
  shortcut: Shortcut,
  getWindow: () => BrowserWindow | null
): MenuItemConstructorOptions {
  return {
    label: shortcut.accelerator ? shortcut.label : `${shortcut.label}  (${shortcut.hint})`,
    accelerator: shortcut.accelerator ?? undefined,
    click: () => send(getWindow(), shortcut.id)
  }
}

/**
 * Build the full template.
 *
 * `getWindow` is a thunk rather than a captured window because the menu outlives
 * any single window — resolving it at CLICK time is what makes a command reach
 * the window that is actually focused.
 */
export function buildMenuTemplate(
  getWindow: () => BrowserWindow | null,
  appName = app.name
): MenuItemConstructorOptions[] {
  const items = (menu: Parameters<typeof shortcutsForMenu>[0]): MenuItemConstructorOptions[] =>
    shortcutsForMenu(menu).map((s) => itemFor(s, getWindow))

  return [
    // The macOS app menu. `role`-based items get the system's own behaviour and
    // localisation for free — hand-rolling Hide/Quit would only get them wrong.
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...items('File').filter((i) => i.accelerator === 'CmdOrCtrl+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      // Settings lives in the app menu on macOS (where users look for it), so it
      // is filtered out here rather than listed twice.
      submenu: items('File').filter((i) => i.accelerator !== 'CmdOrCtrl+,')
    },
    {
      label: 'Edit',
      // Roles, deliberately: the renderer has no undo stack of its own, and
      // wiring fake Undo/Redo items to nothing would be worse than the system
      // ones, which at least work inside every text field.
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    { label: 'Clip', submenu: items('Clip') },
    {
      label: 'View',
      submenu: [
        ...items('View'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' },
    { label: 'Help', role: 'help', submenu: items('Help') }
  ]
}

/** Build and install the application menu. Call once, after `whenReady`. */
export function installApplicationMenu(getWindow: () => BrowserWindow | null): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(getWindow)))
}
