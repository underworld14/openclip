/**
 * tests/unit/shortcuts.spec.ts — the keyboard map, and the menu built from it
 * (FEAT-vvaycm).
 *
 * PRD §11.3 specifies ~9 MVP shortcuts; THREE existed, and all three only fired
 * while the timeline `<div>` held focus. `setApplicationMenu` appeared nowhere in
 * `src/main`, so the app shipped Electron's stock menu — no ⌘N, ⌘O, ⌘I, ⌘E or ⌘,.
 *
 * The properties worth pinning are the ones that make a shortcut layer either
 * invisible or actively hostile:
 *
 *  1. Modifiers match EXACTLY. A subset match makes ⌘⇧E fire plain ⌘E, so a
 *     shortcut you did not press runs.
 *  2. Bare letters are NOT menu accelerators. A menu accelerator is captured
 *     globally and can never reach a focused field — binding "i" would make the
 *     keyword box untypeable.
 *  3. Typing beats bare-key shortcuts, and ⌘-chords still work from a field.
 *  4. The menu, the hook and the help sheet all read ONE table, so a menu item
 *     whose key does nothing is not constructible.
 */

import { describe, expect, it } from 'vitest'
import {
  SHORTCUTS,
  isTypingTarget,
  matchesShortcut,
  shortcutFor,
  shortcutGroups,
  shortcutsForMenu,
  type Shortcut
} from '@shared/shortcuts'
import { MENU_COMMAND_MESSAGE as RENDERER_TAG } from '@renderer/hooks/useGlobalShortcuts'
import { MENU_COMMAND_MESSAGE as PRELOAD_TAG } from '@preload/menu-command'

const chord = (
  key: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}
): Parameters<typeof shortcutFor>[0] => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
})

const byId = (id: Shortcut['id']): Shortcut => SHORTCUTS.find((s) => s.id === id)!

describe('the table is internally consistent', () => {
  it('has unique ids', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length)
  })

  it('gives every entry a label, a hint and a group', () => {
    for (const s of SHORTCUTS) {
      expect(s.label.length, s.id).toBeGreaterThan(0)
      expect(s.hint.length, s.id).toBeGreaterThan(0)
      expect(s.group, s.id).toBeTruthy()
    }
  })

  it('never binds a BARE letter as a menu accelerator', () => {
    // A menu accelerator is captured globally: binding "i" would mean the
    // keyword field could never receive the character.
    for (const s of SHORTCUTS) {
      if (s.accelerator === null) continue
      expect(s.accelerator, s.id).toMatch(/^(CmdOrCtrl|Cmd|Ctrl|Alt|Shift)\+/)
    }
  })

  it('has no two entries answering the same chord', () => {
    // Two handlers for one keystroke means one of them silently never runs.
    const seen = new Map<string, string>()
    for (const s of SHORTCUTS) {
      const sig = [s.key.toLowerCase(), !!s.meta, !!s.shift, !!s.alt].join('|')
      expect(seen.get(sig), `${s.id} collides with ${seen.get(sig)}`).toBeUndefined()
      seen.set(sig, s.id)
    }
  })

  it('covers at least the PRD §11.3 MVP set', () => {
    for (const id of [
      'play-pause',
      'mark-in',
      'mark-out',
      'export-clip',
      'settings',
      'import-video',
      'approve-clip',
      'reject-clip',
      'help'
    ] as const) {
      expect(byId(id), id).toBeTruthy()
    }
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(9)
  })
})

describe('matchesShortcut: modifiers are matched exactly', () => {
  it('matches the plain chord', () => {
    expect(matchesShortcut(byId('export-clip'), chord('e', { metaKey: true }))).toBe(true)
  })

  it('does NOT match when an extra modifier is held', () => {
    // Subset matching would fire ⌘E on ⌘⇧E — a shortcut the user did not press.
    expect(
      matchesShortcut(byId('export-clip'), chord('e', { metaKey: true, shiftKey: true }))
    ).toBe(false)
    expect(matchesShortcut(byId('export-clip'), chord('e', { metaKey: true, altKey: true }))).toBe(
      false
    )
  })

  it('does not match a bare letter when Cmd is held, or vice versa', () => {
    expect(matchesShortcut(byId('mark-in'), chord('i', { metaKey: true }))).toBe(false)
    expect(matchesShortcut(byId('import-video'), chord('i'))).toBe(false)
  })

  it('accepts Ctrl as an alias for Cmd, matching CmdOrCtrl accelerators', () => {
    expect(matchesShortcut(byId('export-clip'), chord('e', { ctrlKey: true }))).toBe(true)
  })

  it('is case-insensitive for letters and exact for named keys', () => {
    expect(matchesShortcut(byId('mark-in'), chord('I'))).toBe(true)
    expect(matchesShortcut(byId('nudge-in-back'), chord('ArrowLeft'))).toBe(true)
    expect(matchesShortcut(byId('nudge-in-back'), chord('arrowleft'))).toBe(false)
  })

  it('separates shifted from unshifted arrow nudges', () => {
    // ⇧← trims the OUT point; ← trims the IN point. Confusing them silently
    // edits the wrong end of the clip.
    expect(shortcutFor(chord('ArrowLeft'))?.id).toBe('nudge-in-back')
    expect(shortcutFor(chord('ArrowLeft', { shiftKey: true }))?.id).toBe('nudge-out-back')
  })

  it('matches `?` whether or not the layout reports shift', () => {
    // The event's `key` is already '?'; demanding shift too makes it unmatchable
    // on layouts that produce it without one.
    expect(shortcutFor(chord('?'))?.id).toBe('help')
    expect(shortcutFor(chord('?', { shiftKey: true }))?.id).toBe('help')
  })

  it('returns undefined for an unmapped chord', () => {
    expect(shortcutFor(chord('q', { metaKey: true, altKey: true }))).toBeUndefined()
    expect(shortcutFor(chord('F13'))).toBeUndefined()
  })
})

describe('isTypingTarget: the rule that makes bare letters safe', () => {
  it('reports the editable elements', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'textarea']) {
      expect(isTypingTarget({ tagName }), tagName).toBe(true)
    }
    expect(isTypingTarget({ isContentEditable: true })).toBe(true)
  })

  it('reports everything else as not typing', () => {
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget({})).toBe(false)
  })
})

describe('grouping for the menu and the help sheet', () => {
  it('assigns every menu-bearing shortcut to exactly one menu', () => {
    const inMenus = (['File', 'Edit', 'Clip', 'View', 'Help'] as const).flatMap((m) =>
      shortcutsForMenu(m)
    )
    const withMenu = SHORTCUTS.filter((s) => s.menu !== null)
    expect(inMenus).toHaveLength(withMenu.length)
    expect(new Set(inMenus.map((s) => s.id)).size).toBe(withMenu.length)
  })

  it('lists EVERY shortcut in the help sheet, including menu-less ones', () => {
    // J/K/L and the arrow nudges have no menu item; the sheet is the only place
    // they are discoverable, so omitting them would hide them completely.
    const listed = shortcutGroups().flatMap((g) => g.items.map((s) => s.id))
    expect(new Set(listed)).toEqual(new Set(SHORTCUTS.map((s) => s.id)))
  })
})

describe('the preload and renderer agree on the message tag', () => {
  it('uses the same literal on both sides', () => {
    // The renderer must not import from the preload, so the tag is declared
    // twice. If they drift, every menu command silently does nothing.
    expect(RENDERER_TAG).toBe(PRELOAD_TAG)
  })
})
