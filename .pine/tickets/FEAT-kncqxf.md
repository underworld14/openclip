---
id: FEAT-kncqxf
title: The whisper-model dialog is an inescapable trap, and completing the download abandons the import that triggered it
status: todo
priority: critical
labels:
    - ux
    - onboarding
    - blocking
parent: EPIC-xzzpty
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

ModelDownloadDialog.tsx:81-84 is a hand-rolled `fixed inset-0` div — not the Radix Dialog — with no `role="dialog"`, no `aria-modal`, no focus trap, no Escape handler, no overlay dismiss, and its only control is the Download button (~:126). Once open, the sole exit is completing a 75MB–2.9GB download. When it finishes, App.tsx:215 `onDownloaded={() => setModelDialogOpen(false)}` merely closes it; import-controller.ts:282-285 and :310-313 already did `set({ busy: false }); return`, so the import is dead and the user must notice and restart it.

## Desired behavior

Convert to the Radix `<Dialog>` used everywhere else (Escape, overlay dismiss, focus trap, labelled title for free) with an explicit Cancel that aborts the model-download job via `jobs.cancel`. Persist the pending import intent; on `onDownloaded`, resume the abandoned import automatically and show 'Resuming import…'. If the user cancels, return them to the Welcome card with the model chip still red rather than a blank screen.

## Competitor precedent

OpusClip's submit panel has no mandatory field at all — every setting has a default so the primary button is always pressable. Kapwing's free tier deliberately completes the whole loop before any gate. LokaClip states model size up front ('~12 MB, downloaded once, then offline') and never blocks the flow on it.

## Verified in the real built app

An adversarial verifier launched the packaged build against a userData dir with no GGML model
and confirmed the trap end to end. Reachability is **100% normal-user**: any first-run import
with no model installed opens this overlay. Once open it swallows Escape, has no close control
and no backdrop dismiss. After the download completes the import that triggered it is not
resumed (`App.tsx` `onDownloaded` only closes the dialog; `import-controller.ts:282-285`
returns early when `ensureModel()` fails) — the user must notice and restart by hand.

## Implementation sketch

Rewrite ModelDownloadDialog.tsx on `components/ui/dialog.tsx` (add `onOpenChange`, keep `data-testid`s for E2E). Add `pendingImport: {kind:'file'|'url', value:string} | null` to the import controller (src/renderer/src/hooks/import-controller.ts) — set it where `ensureModel()` returns false (:282, :310), and expose `resumePending()`. Wire App.tsx:212-216 `onDownloaded` to call it. Track the model-download jobId in the dialog so Cancel can call `window.openclip.jobs.cancel({jobId})`.

## Sizing

Impact: **critical** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
