// @vitest-environment jsdom
/**
 * tests/unit/use-import-controller.spec.tsx — the wiring `useImportController`
 * does, rendered for real (FEAT-26tkya, test #1 in the ticket's value order).
 *
 * This is the regression the EPIC-xzzpty review found and that NO existing test
 * could catch: the import controller is a module singleton, and it used to bake
 * in the `onNeedModel` callback of whichever component constructed it FIRST.
 * React runs a parent's hooks before its children's, so `App` — which passes no
 * callback — always won, and the whisper-model download dialog stopped opening
 * at all. Every unit spec passed because they inject `onNeedModel` straight into
 * the framework-free core, and every E2E called `runImportPipeline` rather than
 * driving the UI.
 *
 * So these specs deliberately go through the REAL path: render a parent that
 * takes no callback around a child that does, then start an import against a
 * bridge whose model probe reports "not installed", and assert the CHILD's
 * callback fired.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import type { OpenClipBridge } from '@preload/index'
import type { ModelStatus } from '@shared/channels'
import type { WhisperModelSize } from '@shared/jobs'
import { installRendererEnv } from '../harness/renderer-env'
import { useImportController } from '@renderer/hooks/useImportController'

let bridge: OpenClipBridge

/** Report every whisper model as absent, so an import hits the model gate. */
function withNoModelInstalled(b: OpenClipBridge): void {
  b.model.status = vi.fn(
    async (req: { model?: WhisperModelSize }): Promise<ModelStatus[]> => [
      { model: req.model ?? 'base', installed: false }
    ]
  )
}

/** A child that registers a need-model callback, like ImportPanel does. */
function Child({ onNeedModel }: { onNeedModel: (m: WhisperModelSize) => void }): React.JSX.Element {
  const ctl = useImportController({ onNeedModel })
  return (
    <div>
      <span data-testid="child-busy">{String(ctl.busy)}</span>
      <button data-testid="child-import" onClick={() => void ctl.importFile('/videos/talk.mp4')}>
        import
      </button>
    </div>
  )
}

/** The parent — App's shape: it uses the controller but passes NO callback. */
function Parent({
  onNeedModel
}: {
  onNeedModel: (m: WhisperModelSize) => void
}): React.JSX.Element {
  const ctl = useImportController()
  return (
    <div>
      <span data-testid="parent-busy">{String(ctl.busy)}</span>
      <span data-testid="parent-pending">{ctl.pendingImport?.value ?? 'none'}</span>
      <Child onNeedModel={onNeedModel} />
    </div>
  )
}

beforeEach(() => {
  bridge = installRendererEnv()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useImportController: the need-model callback survives the singleton', () => {
  it("honours a CHILD's onNeedModel even though the parent constructs the controller", async () => {
    withNoModelInstalled(bridge)
    const onNeedModel = vi.fn()
    render(<Parent onNeedModel={onNeedModel} />)

    // The parent's hook ran first and built the singleton with no callback. If the
    // callback were captured in the controller's closure (the C1 bug), this import
    // would silently do nothing and the dialog would never open.
    await act(async () => {
      screen.getByTestId('child-import').click()
    })

    await waitFor(() => expect(onNeedModel).toHaveBeenCalledTimes(1))
    expect(onNeedModel).toHaveBeenCalledWith('base')
  })

  it('parks the turned-away import as pendingImport so it can be replayed', async () => {
    withNoModelInstalled(bridge)
    render(<Parent onNeedModel={vi.fn()} />)

    await act(async () => {
      screen.getByTestId('child-import').click()
    })

    // The parent observes the pending import the CHILD started — the whole point
    // of the singleton (App resumes the import ImportPanel began, FEAT-kncqxf).
    await waitFor(() =>
      expect(screen.getByTestId('parent-pending').textContent).toBe('/videos/talk.mp4')
    )
  })
})

describe('useImportController: one controller, many components', () => {
  it('both callers observe the SAME controller state, not per-component copies', async () => {
    // Hold the model probe open so `busy` is observable while the import is in flight.
    let releaseProbe: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releaseProbe = r
    })
    bridge.model.status = vi.fn(
      async (req: { model?: WhisperModelSize }): Promise<ModelStatus[]> => {
        await gate
        return [{ model: req.model ?? 'base', installed: false }]
      }
    )

    render(<Parent onNeedModel={vi.fn()} />)
    expect(screen.getByTestId('parent-busy').textContent).toBe('false')

    await act(async () => {
      screen.getByTestId('child-import').click()
    })

    // The child started it; the PARENT — a separate `useImportController()` call —
    // must see it too. A per-component instance would leave the parent at `false`.
    await waitFor(() => {
      expect(screen.getByTestId('child-busy').textContent).toBe('true')
      expect(screen.getByTestId('parent-busy').textContent).toBe('true')
    })

    await act(async () => {
      releaseProbe()
      await gate
    })
    await waitFor(() => expect(screen.getByTestId('parent-busy').textContent).toBe('false'))
  })
})
