---
id: EPIC-k83ghw
title: Production-readiness & UX audit for non-technical users
status: todo
priority: critical
labels:
    - audit
created: "2026-08-15T11:24:43Z"
updated: "2026-08-15T11:24:43Z"
---

# Production-readiness & UX audit (non-technical users)

Full audit of OpenClip for UX, latent bugs, and production readiness, with the target
persona being a **content creator who is not a developer** ("user awam") — never opened a
terminal, may not own an API key, will quit mid-job, unplug drives and lose wifi.

## Method

- 13 parallel audit agents (one per dimension), every finding then re-checked by an
  adversarial verifier that had to refute it against the real code.
  **124 raw findings → 118 confirmed, 6 refuted.**
- Independent verification by driving the **packaged `.app`** (clean userData, no
  `OPENCLIP_*` overrides) with Playwright and reading the real rendered copy.
- All quality gates executed, not assumed.

## Gate results — all green

Measured first at `8cf02c0`, then re-verified at `216f85f` (BUG-45xt77 landed mid-audit):
typecheck pass, lint clean, **1457 passed / 10 skipped across 3 consecutive runs**.

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` | 1433 passed, 8 skipped — **3/3 runs deterministic** |
| `npx electron-vite build` | pass |
| `npx playwright test` | 11 passed, 2 skipped |
| `npm run verify:package` | all 15 assertions pass |
| Gate D (packaged `.app`) | pass — full pipeline from `Contents/Resources` |

**The engineering is production-grade.** Sidecar bundling, licence compliance, the
frozen IPC/job contracts, provider-error humanisation (`ai-errors.ts`) and the
packaged-app proof are better than most commercial desktop apps.

## Verdict

The app is **not shippable to a non-technical user yet**, and the reasons are mostly
*outside* the code that the tests cover:

1. **Distribution** — the repo is private, there is no release, and the README's only
   install path is `git clone && npm install && npm run dev`. The persona cannot obtain
   the app at all. The one `.dmg` that exists is adhoc-signed and Gatekeeper rejects it.
2. **Data loss** — the Zustand store is not project-scoped, so an in-flight job writes
   into whichever project is open when it lands, and autosave persists it. Several
   destructive actions have no confirm and no undo.
3. **Preview ≠ export** — batch export silently discards the caption style and framing
   the user chose in the preview.
4. **Dead controls** — Space, Cancel and timeline zoom do nothing in common situations.
5. **Unguided setup** — nothing anywhere says what an API key is, where to get one, or
   what it costs.

Children are grouped by phase: `p0` = blocks the persona or loses their work,
`p1` = they hit it in normal use, `p2` = quality, a11y, hardening.

Raw audit data: `26 agents · 4.35M tokens · 1489 tool calls`.
