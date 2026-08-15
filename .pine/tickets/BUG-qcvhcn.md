---
id: BUG-qcvhcn
title: 'Accessibility: unreadable focus ring, no reduced-motion, unannounced progress, unselectable transcript'
status: todo
priority: medium
labels:
    - a11y
parent: EPIC-k83ghw
phase: p2
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
A cluster of confirmed accessibility defects, each cheap to fix.

## Evidence
- Focus ring is a translucent grey at **~1.9:1** against the dark ground — below the 3:1
  minimum for a focus indicator.
- `prefers-reduced-motion` is never honoured: per-word caption animations, auto-playing
  hover videos, spinners and dialog zooms all run regardless.
- The job status bar — the app's only progress surface — has no live region, its progress
  bars are unnamed, and it is hidden from assistive tech.
- Every transcript sentence is a `<button>`: thousands of tab stops with no bypass, and the
  transcript text cannot be selected or copied.
- The preview scrub bar is a 4px-tall hairline; several controls are under the 24px minimum
  target size.
- Bare-letter shortcuts (a / x / i / o) are not suppressed while a modal is open, so a stray
  keystroke hides a clip or rewrites its trim.
- The light/dark toggle resets to dark on every launch — the choice is never saved.

## Fix
Raise the focus-ring contrast, add a `prefers-reduced-motion` block, give the status bar
`role="status"` + named progress bars, make transcript lines selectable (click-to-seek via
a wrapper, not a button per sentence), enlarge the scrub bar and small targets, gate
bare-letter shortcuts on no-open-modal, persist the theme.

## Acceptance Criteria
- [ ] Focus indicator meets 3:1
- [ ] Reduced-motion is respected
- [ ] Job progress is announced
- [ ] Transcript text is selectable
- [ ] Shortcuts do not fire while a dialog is open
- [ ] Theme choice survives a restart
