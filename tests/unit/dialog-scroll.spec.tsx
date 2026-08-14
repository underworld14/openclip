// @vitest-environment jsdom
/**
 * tests/unit/dialog-scroll.spec.tsx — a dialog must never grow past the viewport
 * and strand its own controls (FEAT-7ffxsg).
 *
 * `DialogContent` had no `max-h` and no `overflow`, while Settings and Export are
 * both long stacks (provider + model list + key + emoji block + brand editor;
 * caption toggle + template gallery + emoji + silence + reframe + clip picker +
 * batch). At the app's own `minHeight: 600` the lower controls rendered below the
 * fold with no way to reach them — the dialog was, in the literal sense, unusable
 * at the smallest window the app permits.
 *
 * jsdom does no layout, so this asserts the STRUCTURE that produces the fix
 * rather than measured pixels: the frame is bounded, a dedicated body element
 * scrolls, and — the part that is easy to regress — the close button lives
 * OUTSIDE that scroller so it cannot scroll out of reach itself.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@renderer/components/ui/dialog'

function renderDialog(): void {
  render(
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div data-testid="long-body">
          {Array.from({ length: 40 }, (_, i) => (
            <p key={i}>row {i}</p>
          ))}
        </div>
        <DialogFooter>
          <button data-testid="save">Save</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

afterEach(cleanup)

describe('DialogContent: bounded height with a scrolling body', () => {
  it('bounds the frame so it can never exceed the viewport', () => {
    renderDialog()
    const content = document.querySelector('[data-slot="dialog-content"]')!
    expect(content.className).toMatch(/max-h-\[85vh\]/)
  })

  it('puts the overflow on a dedicated body element that can actually shrink', () => {
    renderDialog()
    const body = document.querySelector('[data-slot="dialog-body"]')!
    expect(body).toBeTruthy()
    expect(body.className).toMatch(/overflow-y-auto/)
    // Without `min-h-0` a flex child refuses to shrink below its content height
    // and `overflow-y-auto` never engages — the bug would look fixed and not be.
    expect(body.className).toMatch(/min-h-0/)
  })

  it('renders the dialog content inside the scroller, so long stacks are reachable', () => {
    renderDialog()
    const body = document.querySelector('[data-slot="dialog-body"]')!
    expect(body.contains(screen.getByTestId('long-body'))).toBe(true)
    expect(body.contains(screen.getByTestId('save'))).toBe(true)
  })

  it('keeps the close button OUT of the scroller so it stays pinned', () => {
    renderDialog()
    const body = document.querySelector('[data-slot="dialog-body"]')!
    const close = document.querySelector('[data-slot="dialog-close"]')!
    expect(close).toBeTruthy()
    // The close button is positioned against the frame. If it were inside the
    // scroller it would scroll away with the content, trading one trapped-user
    // bug for another.
    expect(body.contains(close)).toBe(false)
  })

  it('pins the header so you can always see which dialog you are scrolling', () => {
    renderDialog()
    const body = document.querySelector('[data-slot="dialog-body"]')!
    // Applied to the direct-child header via an arbitrary-variant selector, so a
    // header that is a direct child sticks without every dialog opting in.
    expect(body.className).toMatch(/\[&>\[data-slot=dialog-header\]\]:sticky/)
    const header = document.querySelector('[data-slot="dialog-header"]')!
    expect(header.parentElement).toBe(body)
  })

  it('does not scroll the frame itself (that would move the pinned close button)', () => {
    renderDialog()
    const content = document.querySelector('[data-slot="dialog-content"]')!
    expect(content.className).not.toMatch(/overflow-y-auto/)
  })
})
