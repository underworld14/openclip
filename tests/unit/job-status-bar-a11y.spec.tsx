// @vitest-environment jsdom
/**
 * tests/unit/job-status-bar-a11y.spec.tsx — JobStatusBar accessibility
 * (BUG-qcvhcn).
 *
 * The bar is the app's ONLY progress surface, and had no live-region
 * semantics: a screen-reader user got no notification when a job started,
 * progressed or finished, and its `<Progress>` bar (Radix sets
 * role="progressbar" + aria-valuenow/max automatically) had no accessible
 * NAME, so it announced as a bare "N%" with no indication of what.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { installRendererEnv } from '../harness/renderer-env'
import { useJobsStore, __resetJobsStoreForTests } from '@renderer/stores/jobsStore'
import { JobStatusBar } from '@renderer/components/JobStatusBar'

beforeEach(() => {
  installRendererEnv()
  __resetJobsStoreForTests()
})
afterEach(() => {
  cleanup()
})

describe('JobStatusBar: live region', () => {
  it('the bar is a role="status" polite live region', () => {
    useJobsStore.getState().beginTask({ id: 't1', kind: 'export', label: 'clip-1.mp4' })
    render(<JobStatusBar />)
    const bar = screen.getByTestId('job-status-bar')
    expect(bar.getAttribute('role')).toBe('status')
    expect(bar.getAttribute('aria-live')).toBe('polite')
  })
})

describe('JobStatusBar: named progress bar', () => {
  it('the progress bar carries an accessible name describing what is running', () => {
    useJobsStore.getState().beginTask({ id: 't1', kind: 'export', label: 'clip-1.mp4' })
    render(<JobStatusBar />)
    const progress = screen.getByTestId('job-status-progress')
    const name = progress.getAttribute('aria-label')
    expect(name).toBeTruthy()
    expect(name).toContain('clip-1.mp4')
  })

  it('the name updates with the stage as the job progresses', () => {
    // 'encoding' is humanised to "Rendering" by stageLabel() — same mapping
    // the visible stage text uses (jobStatus.ts), so the two never disagree.
    useJobsStore.getState().beginTask({ id: 't1', kind: 'export', label: 'clip-1.mp4' })
    useJobsStore.getState().updateTask('t1', { pct: 40, stage: 'encoding' })
    render(<JobStatusBar />)
    const progress = screen.getByTestId('job-status-progress')
    expect(progress.getAttribute('aria-label')).toMatch(/rendering/i)
  })
})
