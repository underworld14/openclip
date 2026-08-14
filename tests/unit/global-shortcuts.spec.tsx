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
})
