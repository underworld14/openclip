/**
 * useGlobalShortcuts — one document-level keydown listener, plus the menu
 * commands arriving from main (FEAT-vvaycm).
 *
 * `grep -rn "addEventListener('keydown'" src/renderer/src` returned NOTHING
 * before this. The only key handling in the app was three keys on the timeline
 * `<div>`, which had to hold focus first — so Space did not play from anywhere,
 * and I/O did nothing unless you had clicked the timeline.
 *
 * TWO SOURCES, ONE DISPATCH. A keystroke and the matching menu item run the same
 * `ShortcutId` through the same handler map, so they cannot behave differently.
 *
 * THE FOCUS RULE is what makes bare letters safe: a keystroke aimed at an
 * `<input>`, `<textarea>`, `<select>` or contentEditable is left alone. Without
 * it, typing "i" in the keyword field would mark an in-point and swallow the
 * character. `Cmd`-modified chords are still dispatched from a field, because a
 * text input does not consume them and ⌘E should export from wherever you are.
 */

import { useEffect, useRef } from 'react'
import { isTypingTarget, shortcutFor, type ShortcutId } from '@shared/shortcuts'

/**
 * The window-message tag the preload posts menu commands under.
 *
 * Re-declared here rather than imported: the renderer must not import from the
 * preload (the same reason `autosave.ts` re-declares `QUIT_FLUSH_MESSAGE`). Kept
 * in lockstep with `preload/menu-command.ts`, and a unit test asserts the two
 * literals agree.
 */
export const MENU_COMMAND_MESSAGE = 'openclip:menu-command'

/** What to run for each action. Missing ids are simply inert. */
export type ShortcutHandlers = Partial<Record<ShortcutId, () => void>>

/**
 * Install the listeners for the lifetime of the calling component.
 *
 * `handlers` is read through a ref so a caller can pass a fresh object literal
 * every render — the common React shape — without tearing down and reinstalling
 * the document listener on each one.
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const ref = useRef(handlers)
  // Assigned in an effect, never during render: a render-phase ref write is not
  // safe under concurrent rendering (React can discard a render). The effect
  // flushes before any user interaction, so the listener never reads a stale map.
  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    if (!enabled) return

    const run = (id: ShortcutId): void => {
      ref.current[id]?.()
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey
      // Typing wins over bare-key shortcuts; Cmd-chords are dispatched anyway.
      if (!meta && isTypingTarget(e.target as HTMLElement | null)) return
      const shortcut = shortcutFor({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey
      })
      if (!shortcut) return
      if (!ref.current[shortcut.id]) return
      // Only prevent the default once we KNOW we are handling it — swallowing a
      // keystroke we then ignore is how a shortcut layer breaks scrolling.
      e.preventDefault()
      run(shortcut.id)
    }

    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { __openclip?: string; id?: ShortcutId } | null | undefined
      if (!data || data.__openclip !== MENU_COMMAND_MESSAGE || !data.id) return
      run(data.id)
    }

    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('message', onMessage)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('message', onMessage)
    }
  }, [enabled])
}
