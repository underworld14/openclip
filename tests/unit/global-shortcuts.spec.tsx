// @vitest-environment jsdom
/**
 * tests/unit/global-shortcuts.spec.tsx — the document-level shortcut listener
 * (FEAT-vvaycm).
 *
 * `grep -rn "addEventListener('keydown'" src/renderer/src` returned NOTHING
 * before this: the only key handling in the app was three keys on the timeline
 * `<div>`, which had to hold focus first. So Space did not play from anywhere,
 * and I/O did nothing unless you had clicked the timeline.
 *
 * THE LOAD-BEARING BEHAVIOUR is the focus rule. Bare letters as shortcuts are
 * only safe if a keystroke aimed at a text field is left alone — otherwise
 * typing "i" while naming a project marks an in-point AND eats the character,
 * which is a worse app than the one with no shortcuts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useGlobalShortcuts, MENU_COMMAND_MESSAGE } from '@renderer/hooks/useGlobalShortcuts'

/** Dispatch a keydown on `target` (default: document.body). */
function press(
  key: string,
  opts: {
    metaKey?: boolean
    shiftKey?: boolean
    ctrlKey?: boolean
    altKey?: boolean
    target?: Element
  } = {}
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    altKey: opts.altKey ?? false,
    bubbles: true,
    cancelable: true
  })
  ;(opts.target ?? document.body).dispatchEvent(e)
  return e
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('dispatch', () => {
  it('runs the handler for a mapped chord', () => {
    const exportClip = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'export-clip': exportClip }))
    act(() => {
      press('e', { metaKey: true })
    })
    expect(exportClip).toHaveBeenCalledTimes(1)
  })

  it('runs bare-letter shortcuts from anywhere, not only a focused timeline', () => {
    // The whole complaint: Space only played if you had clicked the timeline.
    const playPause = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'play-pause': playPause }))
    act(() => {
      press(' ')
    })
    expect(playPause).toHaveBeenCalledTimes(1)
  })

  it('preventDefaults ONLY what it handles', () => {
    // Swallowing a keystroke and then ignoring it is how a shortcut layer breaks
    // scrolling and text entry everywhere else.
    renderHook(() => useGlobalShortcuts({ 'play-pause': vi.fn() }))
    let handled!: KeyboardEvent
    let ignored!: KeyboardEvent
    act(() => {
      handled = press(' ')
      ignored = press('q')
    })
    expect(handled.defaultPrevented).toBe(true)
    expect(ignored.defaultPrevented).toBe(false)
  })

  it('does not preventDefault a mapped chord with NO handler registered', () => {
    // A shortcut nobody wired up must behave as if it did not exist.
    renderHook(() => useGlobalShortcuts({}))
    let e!: KeyboardEvent
    act(() => {
      e = press(' ')
    })
    expect(e.defaultPrevented).toBe(false)
  })

  it('ignores an unmapped chord', () => {
    const handler = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'play-pause': handler }))
    act(() => {
      press('z', { altKey: true })
    })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('the focus rule', () => {
  const withInput = (tag: 'input' | 'textarea'): HTMLElement => {
    const el = document.createElement(tag)
    document.body.appendChild(el)
    return el
  }

  it('leaves a bare letter alone when the target is a text field', () => {
    // Typing "i" in the keyword box must type an i, not mark an in-point.
    const markIn = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'mark-in': markIn }))
    let e!: KeyboardEvent
    act(() => {
      e = press('i', { target: withInput('input') })
    })
    expect(markIn).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('leaves Space alone in a textarea', () => {
    const playPause = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'play-pause': playPause }))
    act(() => {
      press(' ', { target: withInput('textarea') })
    })
    expect(playPause).not.toHaveBeenCalled()
  })

  it('leaves a bare letter alone in a contentEditable', () => {
    const markIn = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'mark-in': markIn }))
    const el = document.createElement('div')
    el.contentEditable = 'true'
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(el, 'isContentEditable', { value: true })
    document.body.appendChild(el)
    act(() => {
      press('i', { target: el })
    })
    expect(markIn).not.toHaveBeenCalled()
  })

  it('STILL fires a Cmd chord from inside a text field', () => {
    // A text input does not consume ⌘E, and ⌘E should export from wherever the
    // user happens to be — including mid-rename.
    const exportClip = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'export-clip': exportClip }))
    act(() => {
      press('e', { metaKey: true, target: withInput('input') })
    })
    expect(exportClip).toHaveBeenCalledTimes(1)
  })
})

describe('Space on a focused button (EPIC-k83ghw / BUG-bxqmex)', () => {
  const withButton = (): HTMLButtonElement => {
    const el = document.createElement('button')
    document.body.appendChild(el)
    return el
  }

  it('leaves bare Space alone so the button keeps its native activation', () => {
    // Before this fix, the blanket preventDefault() on every matched shortcut
    // suppressed Space's keydown default EVERYWHERE, including on a focused
    // button — and a browser only fires a native click from Space's KEYUP if
    // that default was never suppressed, so Tab-ing to any button and
    // pressing Space silently played the video instead of activating it.
    const playPause = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'play-pause': playPause }))
    let e!: KeyboardEvent
    act(() => {
      e = press(' ', { target: withButton() })
    })
    expect(playPause).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('still fires play-pause for Space anywhere else (a plain div, e.g. the timeline)', () => {
    const playPause = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'play-pause': playPause }))
    const div = document.createElement('div')
    document.body.appendChild(div)
    act(() => {
      press(' ', { target: div })
    })
    expect(playPause).toHaveBeenCalledTimes(1)
  })

  it('still fires a Cmd-chord landing on a button — only bare Space is scoped', () => {
    const exportClip = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'export-clip': exportClip }))
    act(() => {
      press('e', { metaKey: true, target: withButton() })
    })
    expect(exportClip).toHaveBeenCalledTimes(1)
  })
})

describe('application-menu commands', () => {
  it('runs the same handler a keystroke would', () => {
    // One dispatch table for both sources, so a menu item and its key cannot
    // behave differently.
    const settings = vi.fn()
    renderHook(() => useGlobalShortcuts({ settings }))
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { __openclip: MENU_COMMAND_MESSAGE, id: 'settings' } })
      )
    })
    expect(settings).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated window messages', () => {
    const settings = vi.fn()
    renderHook(() => useGlobalShortcuts({ settings }))
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: null }))
      window.dispatchEvent(new MessageEvent('message', { data: 'hello' }))
      window.dispatchEvent(
        new MessageEvent('message', { data: { __openclip: 'openclip:flush-before-quit' } })
      )
    })
    expect(settings).not.toHaveBeenCalled()
  })
})

describe('lifecycle', () => {
  it('reads the LATEST handlers without reinstalling the listener', () => {
    // Callers pass a fresh object literal each render; tearing down the document
    // listener every time would be a per-render cost and a source of dropped keys.
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ h }) => useGlobalShortcuts(h), {
      initialProps: { h: { 'play-pause': first } as Record<string, () => void> }
    })
    rerender({ h: { 'play-pause': second } })
    act(() => {
      press(' ')
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('removes its listeners on unmount', () => {
    const handler = vi.fn()
    const { unmount } = renderHook(() => useGlobalShortcuts({ 'play-pause': handler }))
    unmount()
    act(() => {
      press(' ')
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('installs nothing when disabled', () => {
    const handler = vi.fn()
    renderHook(() => useGlobalShortcuts({ 'play-pause': handler }, false))
    act(() => {
      press(' ')
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('BUG-qcvhcn: toggling enabled false mid-session stops an already-active listener', () => {
    // The real caller (App.tsx): the hook mounts enabled while the editor is
    // shown, then a modal opens and re-renders with enabled=false — bare-letter
    // shortcuts (approve/reject/mark-in/mark-out/…) must stop firing against
    // the editor underneath while the user is looking at the dialog, not just
    // when the hook happens to start out disabled.
    const approve = vi.fn()
    const { rerender } = renderHook(
      ({ enabled }) => useGlobalShortcuts({ 'approve-clip': approve }, enabled),
      {
        initialProps: { enabled: true }
      }
    )
    act(() => {
      press('a')
    })
    expect(approve).toHaveBeenCalledTimes(1)

    rerender({ enabled: false })
    act(() => {
      press('a')
    })
    // Still 1 — the second "a" (modal now open) must not reach the handler.
    expect(approve).toHaveBeenCalledTimes(1)

    rerender({ enabled: true })
    act(() => {
      press('a')
    })
    expect(approve).toHaveBeenCalledTimes(2)
  })
})
