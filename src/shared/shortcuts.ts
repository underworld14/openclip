/**
 * src/shared/shortcuts.ts — the app's keyboard map, in ONE table (FEAT-vvaycm).
 *
 * PRD §11.3 specifies ~9 MVP shortcuts; three existed, and all three only fired
 * while the timeline `<div>` itself held focus — with the key list buried in an
 * `aria-label` where nothing told the user about it. There was no application
 * menu at all (`setApplicationMenu` appears nowhere in `src/main`), so the app
 * ran on Electron's default menu: no Cmd+, no Cmd+E, no Cmd+N, no Cmd+O. This is
 * precisely where a desktop app should beat a browser tool, and it was losing.
 *
 * ONE TABLE, THREE CONSUMERS. The macOS menu (main process), the document-level
 * keydown hook (renderer) and the `?` help sheet all read from here. The
 * alternative — a menu template, a switch statement and a printed list, each
 * maintained by hand — guarantees they disagree, and a menu item whose
 * accelerator does nothing is worse than no menu item.
 *
 * PURE: no Electron, no DOM. `matchesShortcut` takes the four modifier booleans
 * and a key, which is exactly what both a `KeyboardEvent` and a test can supply.
 */

/** Every action a shortcut can trigger. The renderer switches on this. */
export type ShortcutId =
  | 'new-project'
  | 'open-project'
  | 'import-video'
  | 'settings'
  | 'generate-clips'
  | 'export-clip'
  | 'play-pause'
  | 'mark-in'
  | 'mark-out'
  | 'nudge-in-back'
  | 'nudge-in-forward'
  | 'nudge-out-back'
  | 'nudge-out-forward'
  | 'prev-clip'
  | 'next-clip'
  | 'approve-clip'
  | 'reject-clip'
  | 'shuttle-back'
  | 'shuttle-stop'
  | 'shuttle-forward'
  | 'zoom-in'
  | 'zoom-out'
  | 'help'

/** Which menu the item belongs under; `null` ⇒ keyboard-only, no menu entry. */
export type ShortcutMenu = 'File' | 'Edit' | 'Clip' | 'View' | 'Help' | null

export interface Shortcut {
  id: ShortcutId
  /** Menu-item text. */
  label: string
  /** Which menu it lives under (null ⇒ no menu item, keyboard only). */
  menu: ShortcutMenu
  /**
   * Electron accelerator string, or null for keys that must NOT become menu
   * accelerators.
   *
   * A bare letter as an accelerator is captured globally by the menu and can
   * never reach a focused text field — typing "i" in the keyword box would mark
   * an in-point instead. So the single-letter editing keys are handled by the
   * renderer hook (which checks the focus target) and appear in the menu with
   * their key shown as text rather than bound.
   */
  accelerator: string | null
  /** The `KeyboardEvent.key` this matches (lower-cased for letters). */
  key: string
  /** Required modifier state. Absent ⇒ must be absent on the event. */
  meta?: boolean
  shift?: boolean
  alt?: boolean
  /** Human-readable key hint for the help sheet and menu labels. */
  hint: string
  /** Group heading in the `?` sheet. */
  group: 'Project' | 'Playback' | 'Trimming' | 'Clips' | 'View'
}

/**
 * The map. Ordering within a menu is the order here.
 *
 * `Cmd`-prefixed accelerators are safe to bind in the menu: the menu wins over a
 * focused field only for combinations a text field would not consume anyway.
 * Bare letters are deliberately `accelerator: null` — see `Shortcut.accelerator`.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  // --- File -----------------------------------------------------------------
  {
    id: 'new-project',
    label: 'New Project',
    menu: 'File',
    accelerator: 'CmdOrCtrl+N',
    key: 'n',
    meta: true,
    hint: '⌘N',
    group: 'Project'
  },
  {
    id: 'open-project',
    label: 'Open Project…',
    menu: 'File',
    accelerator: 'CmdOrCtrl+O',
    key: 'o',
    meta: true,
    hint: '⌘O',
    group: 'Project'
  },
  {
    id: 'import-video',
    label: 'Import Video…',
    menu: 'File',
    accelerator: 'CmdOrCtrl+I',
    key: 'i',
    meta: true,
    hint: '⌘I',
    group: 'Project'
  },
  {
    id: 'export-clip',
    label: 'Export Clip…',
    menu: 'File',
    accelerator: 'CmdOrCtrl+E',
    key: 'e',
    meta: true,
    hint: '⌘E',
    group: 'Project'
  },
  {
    id: 'settings',
    label: 'Settings…',
    menu: 'File',
    accelerator: 'CmdOrCtrl+,',
    key: ',',
    meta: true,
    hint: '⌘,',
    group: 'Project'
  },
  // --- Clip -----------------------------------------------------------------
  {
    id: 'generate-clips',
    label: 'Generate Clips…',
    menu: 'Clip',
    accelerator: 'CmdOrCtrl+G',
    key: 'g',
    meta: true,
    hint: '⌘G',
    group: 'Clips'
  },
  {
    id: 'approve-clip',
    label: 'Approve Clip',
    menu: 'Clip',
    accelerator: null,
    key: 'a',
    hint: 'A',
    group: 'Clips'
  },
  {
    id: 'reject-clip',
    label: 'Reject Clip',
    menu: 'Clip',
    accelerator: null,
    key: 'x',
    hint: 'X',
    group: 'Clips'
  },
  {
    id: 'prev-clip',
    label: 'Previous Clip',
    menu: 'Clip',
    accelerator: 'CmdOrCtrl+Up',
    key: 'ArrowUp',
    meta: true,
    hint: '⌘↑',
    group: 'Clips'
  },
  {
    id: 'next-clip',
    label: 'Next Clip',
    menu: 'Clip',
    accelerator: 'CmdOrCtrl+Down',
    key: 'ArrowDown',
    meta: true,
    hint: '⌘↓',
    group: 'Clips'
  },
  // --- Playback / trimming (bare keys — renderer-handled) --------------------
  {
    id: 'play-pause',
    label: 'Play / Pause',
    menu: 'View',
    accelerator: null,
    key: ' ',
    hint: 'Space',
    group: 'Playback'
  },
  {
    id: 'shuttle-back',
    label: 'Step Back',
    menu: null,
    accelerator: null,
    key: 'j',
    hint: 'J',
    group: 'Playback'
  },
  {
    id: 'shuttle-stop',
    label: 'Pause',
    menu: null,
    accelerator: null,
    key: 'k',
    hint: 'K',
    group: 'Playback'
  },
  {
    id: 'shuttle-forward',
    label: 'Step Forward',
    menu: null,
    accelerator: null,
    key: 'l',
    hint: 'L',
    group: 'Playback'
  },
  {
    id: 'mark-in',
    label: 'Mark In',
    menu: 'Clip',
    accelerator: null,
    key: 'i',
    hint: 'I',
    group: 'Trimming'
  },
  {
    id: 'mark-out',
    label: 'Mark Out',
    menu: 'Clip',
    accelerator: null,
    key: 'o',
    hint: 'O',
    group: 'Trimming'
  },
  {
    id: 'nudge-in-back',
    label: 'Nudge In Point Back',
    menu: null,
    accelerator: null,
    key: 'ArrowLeft',
    hint: '←',
    group: 'Trimming'
  },
  {
    id: 'nudge-in-forward',
    label: 'Nudge In Point Forward',
    menu: null,
    accelerator: null,
    key: 'ArrowRight',
    hint: '→',
    group: 'Trimming'
  },
  {
    id: 'nudge-out-back',
    label: 'Nudge Out Point Back',
    menu: null,
    accelerator: null,
    key: 'ArrowLeft',
    shift: true,
    hint: '⇧←',
    group: 'Trimming'
  },
  {
    id: 'nudge-out-forward',
    label: 'Nudge Out Point Forward',
    menu: null,
    accelerator: null,
    key: 'ArrowRight',
    shift: true,
    hint: '⇧→',
    group: 'Trimming'
  },
  // --- View -----------------------------------------------------------------
  {
    id: 'zoom-in',
    label: 'Zoom In',
    menu: 'View',
    accelerator: 'CmdOrCtrl+=',
    key: '=',
    meta: true,
    hint: '⌘+',
    group: 'View'
  },
  {
    id: 'zoom-out',
    label: 'Zoom Out',
    menu: 'View',
    accelerator: 'CmdOrCtrl+-',
    key: '-',
    meta: true,
    hint: '⌘−',
    group: 'View'
  },
  {
    id: 'help',
    label: 'Keyboard Shortcuts',
    menu: 'Help',
    accelerator: null,
    key: '?',
    shift: true,
    hint: '?',
    group: 'View'
  }
]

/** A keyboard event, reduced to what matching needs. */
export interface KeyChord {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Does this chord trigger this shortcut?
 *
 * Modifiers are matched EXACTLY, not as a subset: without that, `Cmd+Shift+E`
 * (a different action, or a browser/OS binding) would also fire plain `Cmd+E`.
 * `meta` accepts Cmd OR Ctrl so a `CmdOrCtrl+` accelerator and this matcher
 * agree on every platform.
 */
export function matchesShortcut(shortcut: Shortcut, chord: KeyChord): boolean {
  const key = chord.key.length === 1 ? chord.key.toLowerCase() : chord.key
  const want = shortcut.key.length === 1 ? shortcut.key.toLowerCase() : shortcut.key
  if (key !== want) return false
  const meta = chord.metaKey || chord.ctrlKey
  if (meta !== Boolean(shortcut.meta)) return false
  if (chord.altKey !== Boolean(shortcut.alt)) return false
  // `?` on most layouts REQUIRES shift, and the event's `key` is already '?'.
  // Demanding shift as well would make it unmatchable on layouts where it isn't.
  if (shortcut.key !== '?' && chord.shiftKey !== Boolean(shortcut.shift)) return false
  return true
}

/**
 * The shortcut a chord triggers, or undefined.
 *
 * First match wins, and the table is ordered so the more-specific entry comes
 * first where two could collide (`⇧←` before `←`) — though `matchesShortcut`'s
 * exact-modifier rule already makes them disjoint.
 */
export function shortcutFor(chord: KeyChord): Shortcut | undefined {
  return SHORTCUTS.find((s) => matchesShortcut(s, chord))
}

/**
 * Should this event be ignored because the user is typing?
 *
 * The whole reason bare letters can be shortcuts at all. Without this, pressing
 * "i" while naming a project marks an in-point and eats the character.
 * `Cmd`-modified chords are allowed through: a text field does not consume them,
 * and Cmd+E should export from wherever you are.
 */
export function isTypingTarget(
  target: {
    tagName?: string
    isContentEditable?: boolean
  } | null
): boolean {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = (target.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * True for an element whose own native/ARIA semantics already consume the
 * Space key to activate it — a focused `<button>`, `<a href>`, checkbox/
 * radio, or anything with `role="button"` (EPIC-k83ghw / BUG-bxqmex).
 *
 * Browsers fire a native click from a focused button's Space KEYUP only if
 * Space's keydown default was never suppressed elsewhere first. The global
 * shortcut layer's blanket `preventDefault()` on a matched shortcut swallowed
 * that default for EVERY focused element, so Tab-ing to any button and
 * pressing Space silently played the video instead of activating the
 * button — the standard button-activation key stopped working anywhere in
 * the app (WCAG 2.1.1).
 */
export function isActivationTarget(
  target: {
    tagName?: string
    getAttribute?(name: string): string | null
    type?: string
  } | null
): boolean {
  if (!target) return false
  const tag = (target.tagName ?? '').toUpperCase()
  if (tag === 'BUTTON' || tag === 'A') return true
  const role = target.getAttribute?.('role')
  if (role === 'button' || role === 'checkbox' || role === 'radio' || role === 'link') return true
  if (tag === 'INPUT') {
    const type = (target.type ?? '').toLowerCase()
    return type === 'checkbox' || type === 'radio'
  }
  return false
}

/** Shortcuts grouped for the `?` sheet, in table order. */
export function shortcutGroups(): { group: Shortcut['group']; items: Shortcut[] }[] {
  const order: Shortcut['group'][] = ['Project', 'Playback', 'Trimming', 'Clips', 'View']
  return order
    .map((group) => ({ group, items: SHORTCUTS.filter((s) => s.group === group) }))
    .filter((g) => g.items.length > 0)
}

/** Shortcuts belonging to one application menu, in table order. */
export function shortcutsForMenu(menu: Exclude<ShortcutMenu, null>): Shortcut[] {
  return SHORTCUTS.filter((s) => s.menu === menu)
}
