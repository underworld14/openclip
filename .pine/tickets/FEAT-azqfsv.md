---
id: FEAT-azqfsv
title: Deferred code-review items from EPIC-xzzpty
status: todo
priority: low
labels:
    - cleanup
parent: EPIC-4sa5jb
created: "2026-08-08T18:22:47Z"
updated: "2026-08-08T18:22:47Z"
---

Small items surfaced by the EPIC-xzzpty code review, deliberately deferred rather than folded into the fix pass.

## 1. `NOT_IMPLEMENTED` is a message prefix, not a typed error

`src/main/ipc/ai.ts` — `GENERATE_TITLES` and rewrite-mode `ENHANCE_CAPTIONS` now reject with `new Error('NOT_IMPLEMENTED: …')`. FEAT-et1gxc asked for a typed `JobError('NOT_IMPLEMENTED', …)` "so callers can branch".

The prefix is pragmatic — `ipcMain.handle` flattens an error to its message across IPC, so `JobError.code` is lost anyway (there is an existing comment about this in `job-start-validation.ts`). But a caller that wants to branch has to string-match, which is the thing typed errors exist to avoid. Decide: either accept the prefix and document it as the convention, or give the control plane the same typed-error envelope the job plane has.

## 2. FEAT-c5a15c's Welcome-card checklist was not built

Only the title-bar chips shipped. The ticket's "Desired behavior" also asked for "the same three rows as a green-check checklist" on the Welcome card. The chips ARE visible on Welcome, so a first-run user does see the state — this may be sufficient. Confirm the scope call or build the checklist.

## 3. `preflight.ytDlp` is collected and never used

`SYSTEM_PREFLIGHT` reports `ytDlp`, and `readinessView` ignores it. A missing yt-dlp only affects URL import, so it does not belong in the three general chips — but either gate URL import on it (the import field could say so when a URL is pasted) or drop it from the payload. Reporting something nothing reads is how `whisperCli` ended up probed-and-ignored.

## 4. The model auto-fill effect can clobber in-progress typing

`SettingsPanel.tsx` — the seed effect fires again when the catalogue arrives. The model field keeps a local `modelDraft` and only persists on blur, so if the user starts typing before `/models` resolves, `settings.model` is still `''`, the effect saves `models[0].id`, and the render-phase sync overwrites the draft. No loop (the blank-field guard terminates it), but it is a real race on a slow network, and it also means the field cannot be deliberately left empty.

Fix direction: skip the seed once the input has been focused/edited this session, or seed only on provider change rather than on every catalogue arrival. Needs the renderer test harness ([[FEAT-renderer-harness]]) to test properly.
