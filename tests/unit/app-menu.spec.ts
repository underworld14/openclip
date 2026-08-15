/**
 * tests/unit/app-menu.spec.ts — the application menu (FEAT-vvaycm).
 *
 * `setApplicationMenu` / `Menu.buildFromTemplate` appeared NOWHERE in `src/main`,
 * so the app shipped Electron's stock menu: no ⌘N, ⌘O, ⌘I, ⌘E, ⌘,. On macOS the
 * menu bar is where a user LOOKS for what an app can do — a shortcut that is not
 * in it may as well not exist.
 *
 * What is asserted is the part a template can get wrong invisibly: that clicking
 * an item reaches the focused window with the right command, that the window is
 * resolved at CLICK time rather than captured at build time, and that Settings
 * appears exactly once (macOS convention puts it in the app menu, and listing it
 * in File as well is the easy mistake).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * `menu.ts` imports `electron` statically, so a module mock intercepts it. (The
 * repo's settings module needs the pure-core treatment instead because it
 * lazy-`require`s — this one does not.)
 */
vi.mock('electron', () => ({
  app: { name: 'OpenClip' },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((t) => t) }
}))

import { buildMenuTemplate } from '@main/menu'
import { IPCChannels } from '@shared/channels'
import { SHORTCUTS } from '@shared/shortcuts'

type Item = {
  label?: string
  accelerator?: string
  role?: string
  type?: string
  submenu?: Item[]
}

let sent: { channel: string; arg: unknown }[]
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, arg: unknown) => sent.push({ channel, arg })
  }
}

beforeEach(() => {
  sent = []
})

function template(getWindow = (): typeof fakeWindow | null => fakeWindow): Item[] {
  return buildMenuTemplate(getWindow as never, 'OpenClip') as Item[]
}

function menuNamed(t: Item[], label: string): Item {
  const m = t.find((x) => x.label === label)
  if (!m) throw new Error(`no "${label}" menu`)
  return m
}

/** Every leaf item in the template, flattened. */
function allItems(t: Item[]): Item[] {
  return t.flatMap((m) => m.submenu ?? [])
}

describe('the template', () => {
  it('has the menus a macOS app is expected to have', () => {
    const labels = template().map((m) => m.label ?? m.role)
    expect(labels).toEqual(
      expect.arrayContaining(['OpenClip', 'File', 'Edit', 'Clip', 'View', 'Help'])
    )
  })

  it('carries the ⌘ accelerators that were missing entirely', () => {
    const accels = allItems(template())
      .map((i) => i.accelerator)
      .filter(Boolean)
    for (const a of ['CmdOrCtrl+N', 'CmdOrCtrl+O', 'CmdOrCtrl+I', 'CmdOrCtrl+E', 'CmdOrCtrl+,']) {
      expect(accels, a).toContain(a)
    }
  })

  it('lists Settings ONCE, in the app menu where macOS users look', () => {
    const t = template()
    const settingsItems = allItems(t).filter((i) => i.accelerator === 'CmdOrCtrl+,')
    expect(settingsItems).toHaveLength(1)
    expect(menuNamed(t, 'OpenClip').submenu?.some((i) => i.accelerator === 'CmdOrCtrl+,')).toBe(
      true
    )
    expect(menuNamed(t, 'File').submenu?.some((i) => i.accelerator === 'CmdOrCtrl+,')).toBe(false)
  })

  it('shows the key IN THE LABEL for items with no accelerator', () => {
    // Bare letters cannot be menu accelerators (they would be captured globally
    // and never reach a text field), but they must still be discoverable.
    const markIn = allItems(template()).find((i) => i.label?.startsWith('Mark In'))
    expect(markIn?.accelerator).toBeUndefined()
    expect(markIn?.label).toContain('(I)')
  })

  it('uses system ROLES for the clipboard and window items', () => {
    // Hand-rolled Cut/Copy/Paste would only get the system behaviour wrong.
    const editRoles = menuNamed(template(), 'Edit').submenu?.map((i) => i.role)
    expect(editRoles).toEqual(expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste']))
  })
})

describe('clicking an item', () => {
  const clickByLabel = (t: Item[], startsWith: string): void => {
    const item = allItems(t).find((i) => i.label?.startsWith(startsWith)) as
      | (Item & { click?: () => void })
      | undefined
    if (!item?.click) throw new Error(`no clickable item "${startsWith}"`)
    item.click()
  }

  it('sends the shortcut id over the one-way menu channel', () => {
    clickByLabel(template(), 'Export Clip')
    expect(sent).toEqual([{ channel: IPCChannels.MENU_COMMAND, arg: 'export-clip' }])
  })

  it('resolves the window at CLICK time, not at build time', () => {
    // The menu outlives any single window; capturing one at build time would
    // send commands to a window that is no longer focused (or is destroyed).
    let current: typeof fakeWindow | null = null
    const t = template(() => current)
    clickByLabel(t, 'Export Clip')
    expect(sent).toHaveLength(0) // no window yet — silently no-ops, does not throw

    current = fakeWindow
    clickByLabel(t, 'Export Clip')
    expect(sent).toHaveLength(1)
  })

  it('does not send to a destroyed window', () => {
    const dead = { ...fakeWindow, isDestroyed: () => true }
    clickByLabel(
      template(() => dead as never),
      'Export Clip'
    )
    expect(sent).toHaveLength(0)
  })
})

describe('Check for Updates… (EPIC-k83ghw / FEAT-x9femg)', () => {
  it('is absent when no handler is given (backward compatible)', () => {
    const app = menuNamed(template(), 'OpenClip')
    expect(app.submenu?.some((i) => i.label === 'Check for Updates…')).toBe(false)
  })

  it('appears in the app menu and calls the handler when clicked', () => {
    const onCheckForUpdates = vi.fn()
    const t = buildMenuTemplate(
      (() => fakeWindow) as never,
      'OpenClip',
      onCheckForUpdates
    ) as Item[]
    const app = menuNamed(t, 'OpenClip')
    const item = app.submenu?.find((i) => i.label === 'Check for Updates…') as
      | { click?: () => void }
      | undefined
    expect(item).toBeTruthy()
    item?.click?.()
    expect(onCheckForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('the menu and the keyboard map cannot disagree', () => {
  it('builds every menu-bearing shortcut into the template', () => {
    // Both read the one shared table — this asserts nothing is dropped in
    // translation, which is how a menu item whose key does nothing appears.
    const labels = allItems(template()).map((i) => i.label ?? '')
    for (const s of SHORTCUTS.filter((x) => x.menu !== null)) {
      expect(
        labels.some((l) => l.startsWith(s.label)),
        `${s.id} (${s.label}) missing from the menu`
      ).toBe(true)
    }
  })
})
