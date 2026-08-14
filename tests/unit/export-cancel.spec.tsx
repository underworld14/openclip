// @vitest-environment jsdom
/**
 * tests/unit/export-cancel.spec.tsx — a running single-clip export can be
 * stopped, and dismissing the dialog does not silently strand it (FEAT-az3sxm).
 *
 * The panel rendered only an "Export clip" button, disabled while running, with
 * no cancel — while the batch path a few lines below has had "Cancel all" all
 * along. And App mounted the dialog with Radix's default dismiss behaviour, so
 * Escape or an overlay click unmounted the progress bar, the done state and the
 * "Open folder" button while the ffmpeg child kept encoding.
 *
 * The encode surviving dismissal is the RIGHT behaviour — JobStatusBar is
 * mounted outside every modal and keeps the row reachable, which is how OpusClip
 * and Kapwing behave. The defect was that nothing said so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import type { OpenClipBridge } from '@preload/index'
import { installRendererEnv } from '../harness/renderer-env'
import { useProjectStore } from '@renderer/stores/projectStore'
import { useJobsStore, __resetJobsStoreForTests } from '@renderer/stores/jobsStore'
import { activeTasks } from '@renderer/components/jobStatus'
import { ExportPanel } from '@renderer/components/ExportPanel'
import { projectFixture, clipFixture } from '../fixtures/contract'

let bridge: OpenClipBridge

/** An export that streams progress and never reaches `done`. */
const SLOW_EXPORT = {
  steps: [
    { t: 'progress', pct: 10, stage: 'encoding' },
    { t: 'progress', pct: 20, stage: 'encoding' }
  ],
  stepDelayMs: 50_000
} as never

beforeEach(() => {
  bridge = installRendererEnv()
  __resetJobsStoreForTests()
  useProjectStore.setState({
    currentProject: projectFixture,
    clips: [{ ...clipFixture, status: 'approved' }],
    selectedClipId: clipFixture.id
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('single-clip export: cancel', () => {
  it('offers Cancel only while an export is running', async () => {
    render(<ExportPanel />)
    // Idle: no cancel, because there is nothing to cancel.
    expect(screen.queryByTestId('export-cancel')).toBeNull()
    expect(screen.getByTestId('export-start')).toBeTruthy()
  })

  it('cancels the in-flight job by id', async () => {
    // An export job that streams progress and never terminates, so the running
    // state is observable. Gating `jobs.start` itself would block BEFORE
    // `onStart` fires, and the panel would never learn the job id.
    bridge = installRendererEnv({ scripts: { export: SLOW_EXPORT } })
    const cancel = vi.fn(async (jobId: string) => {
      void jobId
    })
    bridge.jobs.cancel = cancel

    render(<ExportPanel />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-start'))
    })

    await waitFor(() => expect(screen.getByTestId('export-cancel')).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-cancel'))
    })

    // The sidecar already SIGKILLs the child and cleans the .part.mp4 — the only
    // thing missing was a caller. Assert it got the id the job actually started
    // with, not some placeholder.
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0][0]).toMatch(/^export-/)
  })
})

describe('dismissing the dialog mid-export', () => {
  it('leaves the job active in the app-level registry, not stranded', async () => {
    bridge = installRendererEnv({ scripts: { export: SLOW_EXPORT } })
    const { unmount } = render(<ExportPanel />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-start'))
    })
    await waitFor(() =>
      expect(activeTasks(useJobsStore.getState().tasks).some((t) => t.kind === 'export')).toBe(true)
    )

    // Dismissal unmounts the panel. The task must survive it — that registry is
    // what App reads to decide whether to say "continues in the background", and
    // what JobStatusBar renders so Cancel and Open folder stay reachable.
    unmount()
    expect(activeTasks(useJobsStore.getState().tasks).some((t) => t.kind === 'export')).toBe(true)
  })
})
