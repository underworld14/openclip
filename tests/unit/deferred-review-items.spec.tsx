// @vitest-environment jsdom
/**
 * tests/unit/deferred-review-items.spec.tsx — the small items the EPIC-xzzpty
 * review deferred rather than folding into the fix pass (FEAT-azqfsv).
 *
 * Two were code changes and are asserted here:
 *
 *  1. `NOT_IMPLEMENTED` was a bare message prefix, so a caller that wanted to
 *     branch had to string-match — the exact fragility typed errors exist to
 *     avoid, relocated to every call site. `ipcMain.handle` FLATTENS a rejection
 *     to its message, so a typed error class genuinely cannot cross the control
 *     plane; the fix is one convention and one predicate rather than a class.
 *
 *  2. `SYSTEM_PREFLIGHT` reported `ytDlp` and NOTHING read it. Reporting
 *     something nothing reads is precisely how `whisperCli` ended up
 *     probed-and-ignored. A missing yt-dlp only breaks URL import, so it is
 *     surfaced where it matters — the instant a URL is in the field — rather
 *     than as a fourth always-visible readiness chip.
 *
 * The other two items were scope calls, recorded on the ticket: the readiness
 * chips already render on the Welcome screen (the bar is in the app header, which
 * both screens share), and the model auto-fill race was fixed earlier and is
 * covered by `settings-panel-model-draft.spec.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { installRendererEnv } from '../harness/renderer-env'
import { ImportPanel } from '@renderer/components/ImportPanel'
import { isNotImplemented, notImplemented, NOT_IMPLEMENTED } from '@shared/ipc-errors'
import type { PreflightResult } from '@shared/channels'

const TOOL = (ok: boolean): { ok: boolean; path?: string } =>
  ok ? { ok: true, path: '/bin/x' } : { ok: false }

function preflight(ytDlpOk: boolean): PreflightResult {
  return {
    ffmpeg: TOOL(true),
    ffprobe: TOOL(true),
    whisperCli: TOOL(true),
    ytDlp: TOOL(ytDlpOk)
  } as PreflightResult
}

beforeEach(() => {
  installRendererEnv()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NOT_IMPLEMENTED is branchable, not string-matched at every call site', () => {
  it('round-trips through the predicate', () => {
    const err = notImplemented('AI title generation is not built yet.')
    expect(isNotImplemented(err)).toBe(true)
    expect(err.message).toContain(NOT_IMPLEMENTED)
    // The detail survives — the prefix is an addition, not a replacement.
    expect(err.message).toContain('AI title generation')
  })

  it('survives the flattening `ipcMain.handle` performs', () => {
    // The constraint the whole convention exists for: a rejection crosses IPC as
    // a message STRING, so a typed error class cannot make the trip.
    const flattened = new Error(notImplemented('caption rewrite').message)
    expect(isNotImplemented(flattened)).toBe(true)
    // …and as a bare string, which some serialisation paths produce.
    expect(isNotImplemented(notImplemented('x').message)).toBe(true)
  })

  it('does not match an ordinary failure', () => {
    expect(isNotImplemented(new Error('ENOENT: no such file'))).toBe(false)
    expect(isNotImplemented(null)).toBe(false)
    expect(isNotImplemented(undefined)).toBe(false)
    expect(isNotImplemented({ code: 'NOT_IMPLEMENTED' })).toBe(false)
  })
})

describe('a missing yt-dlp is surfaced where it matters', () => {
  const typeUrl = async (v: string): Promise<void> => {
    await act(async () => {
      fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: v } })
    })
  }

  it('blocks a URL import and says why', async () => {
    window.openclip.system.preflight = async () => preflight(false)
    render(<ImportPanel />)
    await typeUrl('https://youtube.com/watch?v=abc')
    await waitFor(() => expect(screen.getByTestId('url-import-blocked')).toBeTruthy())
    expect(screen.getByTestId('url-import-blocked').textContent).toMatch(/yt-dlp/i)
    expect((screen.getByTestId('import-start') as HTMLButtonElement).disabled).toBe(true)
  })

  it('leaves FILE import alone — yt-dlp has nothing to do with it', async () => {
    // This is why it is not a fourth readiness chip: a missing yt-dlp is not a
    // general "the app is not ready" condition.
    window.openclip.system.preflight = async () => preflight(false)
    render(<ImportPanel />)
    await typeUrl('/Users/me/video.mp4')
    await waitFor(() =>
      expect((screen.getByTestId('import-start') as HTMLButtonElement).disabled).toBe(false)
    )
    expect(screen.queryByTestId('url-import-blocked')).toBeNull()
  })

  it('allows the URL when yt-dlp is present', async () => {
    window.openclip.system.preflight = async () => preflight(true)
    render(<ImportPanel />)
    await typeUrl('https://youtube.com/watch?v=abc')
    await waitFor(() =>
      expect((screen.getByTestId('import-start') as HTMLButtonElement).disabled).toBe(false)
    )
    expect(screen.queryByTestId('url-import-blocked')).toBeNull()
  })

  it('does not block while the probe is still in flight', async () => {
    // Blocking a paste on a probe that has not answered would be worse than
    // letting the download fail with the real error.
    window.openclip.system.preflight = () => new Promise(() => {})
    render(<ImportPanel />)
    await typeUrl('https://youtube.com/watch?v=abc')
    expect(screen.queryByTestId('url-import-blocked')).toBeNull()
    expect((screen.getByTestId('import-start') as HTMLButtonElement).disabled).toBe(false)
  })
})
