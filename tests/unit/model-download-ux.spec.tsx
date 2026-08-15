// @vitest-environment jsdom
/**
 * tests/unit/model-download-ux.spec.tsx — the two interaction defects reported
 * from the packaged app (BUG-45xt77).
 *
 *  A. Clicking "Download" on a NAMED model row opened a modal titled "Choose a
 *     transcription model" and asked which model to download. All three entry
 *     points already carried a concrete size into `initialModel`, so the picker
 *     re-asked a question the click had answered.
 *  B. Dismissing that modal — Escape, backdrop, ✕, "Not now" — CANCELLED the
 *     download. Combined with Radix's `modal` making the status bar click-inert
 *     underneath, there was no way to let a multi-GB transfer continue.
 *
 * `TranscriptionSettings` had no spec at all before this file, which is how a
 * pure-friction prompt shipped.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import type { OpenClipBridge } from '@preload/index'
import { installRendererEnv } from '../harness/renderer-env'
import { TranscriptionSettings } from '@renderer/components/TranscriptionSettings'
import { ModelDownloadDialog } from '@renderer/components/ModelDownloadDialog'
import { useJobsStore } from '@renderer/stores/jobsStore'
import { modelDownloadPartialFixture } from '../fixtures/contract'

let bridge: OpenClipBridge

/**
 * Wrap the mock bridge's job API in spies. `jobs.start`/`jobs.cancel` are real
 * implementations (the mock drives a scripted port), not `vi.fn`s.
 */
function spyOnJobs(): { start: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
  const start = vi.fn(bridge.jobs.start.bind(bridge.jobs))
  const cancel = vi.fn(bridge.jobs.cancel.bind(bridge.jobs))
  bridge.jobs.start = start as unknown as OpenClipBridge['jobs']['start']
  bridge.jobs.cancel = cancel as unknown as OpenClipBridge['jobs']['cancel']
  return { start, cancel }
}

function mount(installed: string[] = []): void {
  bridge = installRendererEnv({})
  bridge.model.status = vi.fn(async () =>
    ['tiny', 'base', 'small', 'medium', 'turbo', 'large-v3'].map((model) =>
      installed.includes(model)
        ? { model, installed: true, path: `/models/ggml-${model}.bin`, bytes: 147_951_465 }
        : { model, installed: false }
    )
  ) as unknown as OpenClipBridge['model']['status']
  useJobsStore.setState({ tasks: {} })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Settings row Download starts the job itself (defect A)', () => {
  it('does not route through a picker — the row already names the model', async () => {
    const onDownloadStarted = vi.fn()
    mount()
    const jobs = spyOnJobs()
    render(
      <TranscriptionSettings
        active="base"
        onSelect={() => {}}
        onDownloadStarted={onDownloadStarted}
      />
    )

    const button = await screen.findByTestId('whisper-download-small')
    await act(async () => {
      fireEvent.click(button)
    })

    // The click starts a real job…
    await waitFor(() => expect(jobs.start).toHaveBeenCalled())
    expect(jobs.start).toHaveBeenCalledWith('model-download', { model: 'small' })
    // …for the model whose row was clicked, and tells the app so it can toast.
    expect(onDownloadStarted).toHaveBeenCalledWith('small')
  })

  it('shows progress in the row rather than in a modal', async () => {
    // A script that reports a partial and never terminates, so the in-flight
    // state is observable rather than a race against completion.
    bridge = installRendererEnv({
      scripts: {
        'model-download': { steps: [{ t: 'partial', data: modelDownloadPartialFixture }] }
      }
    })
    bridge.model.status = vi.fn(async () => []) as unknown as OpenClipBridge['model']['status']
    useJobsStore.setState({ tasks: {} })
    render(<TranscriptionSettings active="base" onSelect={() => {}} />)

    await act(async () => {
      fireEvent.click(await screen.findByTestId('whisper-download-small'))
    })

    // The row reports for itself; the status bar covers the app-wide view.
    await waitFor(() => expect(screen.queryByTestId('whisper-progress-small')).toBeTruthy())
  })

  it('flips the row to Installed when the download finishes', async () => {
    // Previously only a DELETE re-read the installed set, so a finished model
    // still offered "Download" until Settings was closed and reopened.
    mount()
    const onChanged = vi.fn()
    render(<TranscriptionSettings active="base" onSelect={() => {}} onChanged={onChanged} />)

    await act(async () => {
      fireEvent.click(await screen.findByTestId('whisper-download-small'))
    })

    // The mock bridge's model-download script runs to `done`; the row re-reads.
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(bridge.model.status).toHaveBeenCalledTimes(2) // mount + post-download
  })

  it('registers the download as a status-bar task, so it is visible app-wide', async () => {
    mount()
    render(<TranscriptionSettings active="base" onSelect={() => {}} />)

    await act(async () => {
      fireEvent.click(await screen.findByTestId('whisper-download-small'))
    })

    await waitFor(() => {
      const tasks = Object.values(useJobsStore.getState().tasks)
      expect(tasks.some((t) => t.kind === 'model-download' && t.label === 'small')).toBe(true)
    })
  })
})

describe('the import-gate dialog no longer kills the download on dismiss (defect B)', () => {
  it('leaves the transfer running and reports that it did', async () => {
    // Never-terminating script, so the transfer is genuinely still in flight at
    // the moment of dismissal — with the default script it would already be done
    // and the assertion would prove nothing.
    bridge = installRendererEnv({
      scripts: {
        'model-download': { steps: [{ t: 'partial', data: modelDownloadPartialFixture }] }
      }
    })
    useJobsStore.setState({ tasks: {} })
    const jobs = spyOnJobs()
    const onDismiss = vi.fn()
    render(<ModelDownloadDialog open initialModel="small" onDismiss={onDismiss} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('model-download-start'))
    })
    await waitFor(() => expect(jobs.start).toHaveBeenCalled())

    await act(async () => {
      fireEvent.click(screen.getByTestId('model-download-dismiss'))
    })

    // THE regression: dismissing used to call jobs.cancel.
    expect(jobs.cancel).not.toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledWith(true) // "still downloading" → App toasts
  })

  it('still cancels when the user explicitly asks to', async () => {
    // Same never-terminating script: the Cancel button only exists while busy.
    bridge = installRendererEnv({
      scripts: {
        'model-download': { steps: [{ t: 'partial', data: modelDownloadPartialFixture }] }
      }
    })
    useJobsStore.setState({ tasks: {} })
    const jobs = spyOnJobs()
    const onDismiss = vi.fn()
    render(<ModelDownloadDialog open initialModel="small" onDismiss={onDismiss} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('model-download-start'))
    })
    await waitFor(() => expect(jobs.start).toHaveBeenCalled())

    const cancel = await screen.findByTestId('model-download-cancel')
    await act(async () => {
      fireEvent.click(cancel)
    })

    await waitFor(() => expect(jobs.cancel).toHaveBeenCalled())
    expect(onDismiss).toHaveBeenCalledWith(false)
  })

  it('offers no cancel button until something is actually downloading', async () => {
    mount()
    render(<ModelDownloadDialog open initialModel="small" />)
    expect(screen.queryByTestId('model-download-cancel')).toBeNull()
    expect(screen.getByTestId('model-download-dismiss').textContent).toBe('Not now')
  })
})
