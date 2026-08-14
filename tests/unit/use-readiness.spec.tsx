// @vitest-environment jsdom
/**
 * tests/unit/use-readiness.spec.tsx — `useReadiness`'s effect wiring
 * (FEAT-26tkya, test #2 in the ticket's value order).
 *
 * `readinessView` itself is pure and already well covered. What was NOT covered
 * is the part that can only exist in a rendered component: the two probe effects,
 * their failure handling, and the `refresh()` re-probe. Those matter because the
 * whole point of the hook's `null`-vs-`false` distinction is to avoid claiming a
 * failure it never observed — an invariant that lives entirely in the effects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import type { OpenClipBridge } from '@preload/index'
import type { ModelStatus, PreflightResult } from '@shared/channels'
import type { WhisperModelSize } from '@shared/jobs'
import { installRendererEnv } from '../harness/renderer-env'
import { useReadiness } from '@renderer/hooks/useReadiness'

let bridge: OpenClipBridge

const chip = (r: { chips: Array<{ id: string; state: string }> }, id: string): string =>
  r.chips.find((c) => c.id === id)!.state

beforeEach(() => {
  bridge = installRendererEnv()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useReadiness: an unresolved probe is "unknown", never a failure', () => {
  it('renders the engine chip as unknown while system.preflight is still in flight', async () => {
    // A probe that never settles — the first-paint state.
    bridge.system.preflight = vi.fn((): Promise<PreflightResult> => new Promise(() => {}))
    bridge.model.status = vi.fn((): Promise<ModelStatus[]> => new Promise(() => {}))

    const { result } = renderHook(() => useReadiness())

    expect(chip(result.current, 'engine')).toBe('unknown')
    expect(chip(result.current, 'transcription')).toBe('unknown')
  })

  it('a REJECTED preflight still renders unknown — we never observed a failure', async () => {
    bridge.system.preflight = vi.fn(async (): Promise<PreflightResult> => {
      throw new Error('IPC blew up')
    })

    const { result } = renderHook(() => useReadiness())

    // Give the rejection a chance to land; the chip must NOT flip to `missing`.
    await act(async () => {
      await Promise.resolve()
    })
    expect(chip(result.current, 'engine')).toBe('unknown')
  })

  it('a REJECTED model.status does gate transcription — absence there IS observable', async () => {
    bridge.model.status = vi.fn(async (): Promise<ModelStatus[]> => {
      throw new Error('IPC blew up')
    })

    const { result } = renderHook(() => useReadiness())

    await waitFor(() => expect(chip(result.current, 'transcription')).toBe('missing'))
  })
})

describe('useReadiness: refresh() re-probes the model', () => {
  it('flips transcription to ok when a download completes and refresh() is called', async () => {
    let installed = false
    bridge.model.status = vi.fn(
      async (req: { model?: WhisperModelSize }): Promise<ModelStatus[]> => [
        { model: req.model ?? 'base', installed, path: '/models/x.bin', bytes: 1 }
      ]
    )

    const { result } = renderHook(() => useReadiness())
    await waitFor(() => expect(chip(result.current, 'transcription')).toBe('missing'))
    expect(bridge.model.status).toHaveBeenCalledTimes(1)

    // The model finished downloading out-of-band. Without refresh() the chip would
    // stay red until an app restart — the reason the hook exposes it at all.
    installed = true
    await act(async () => {
      result.current.refresh()
    })

    await waitFor(() => expect(chip(result.current, 'transcription')).toBe('ok'))
    expect(bridge.model.status).toHaveBeenCalledTimes(2)
  })

  it('probes binaries ONCE but re-probes the model on every refresh', async () => {
    // The mock's methods are plain functions, so wrap the two we want to count.
    const preflight = vi.fn(bridge.system.preflight)
    const status = vi.fn(bridge.model.status)
    bridge.system.preflight = preflight
    bridge.model.status = status

    const { result } = renderHook(() => useReadiness())
    await waitFor(() => expect(preflight).toHaveBeenCalledTimes(1))

    await act(async () => {
      result.current.refresh()
    })
    await act(async () => {
      result.current.refresh()
    })

    await waitFor(() => expect(status).toHaveBeenCalledTimes(3))
    // Binaries can't change while the app runs, so this stays at one.
    expect(preflight).toHaveBeenCalledTimes(1)
  })
})
