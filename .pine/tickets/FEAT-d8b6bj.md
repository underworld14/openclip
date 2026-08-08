---
id: FEAT-d8b6bj
title: No README, LICENSE, or CONTRIBUTING — plus a GPL-ffmpeg-in-MIT-app compliance gap
status: todo
priority: high
labels:
    - oss
    - docs
    - legal
parent: EPIC-9gkehb
created: "2026-08-08T15:31:59Z"
updated: "2026-08-08T15:31:59Z"
---

## Problem

The repo has **no `README.md`, no `LICENSE`, no `CONTRIBUTING.md`, no `CODE_OF_CONDUCT.md`** — yet `package.json` declares `"license": "MIT"` and `"homepage": "https://github.com/openclip/openclip-desktop"`.

```
$ ls README* LICENSE* CONTRIBUTING* 2>&1
zsh: no matches found: README*
$ ls docs/
auto-reframe-design.md  PACKAGING.md  prd.md
```

PRD §20.1 / §20.3 require all of these.

## Why it matters

This is the single largest gap between "a well-engineered interior" and "a project a stranger can adopt". A GUI video app with no README, **no screenshots and no demo GIF** gives a visitor nothing to evaluate. Every competitor studied in this sweep leads with a visual.

There is also a **license-compliance problem**, not just a paperwork one: `scripts/bundle-binaries.mjs:10,68-69` deliberately ships a **GPL** FFmpeg build inside an app declared MIT, and neither the GPL text nor a written offer of source is packaged. `docs/PACKAGING.md` has also drifted — it says ffmpeg/ffprobe are "staged from `node_modules`" while the script explicitly *rejects* the `ffmpeg-static` build as non-redistributable (`--enable-nonfree`).

## Acceptance criteria

- [ ] `README.md`: one-line pitch, a demo GIF or screenshot of the 3-pane editor, the privacy/BYOK differentiator stated up front, quickstart (prereqs → `npm i` → `npm run dev`), the BYOK key setup step, and a feature/roadmap table honest about what is MVP vs stubbed.
- [ ] `LICENSE` (MIT) at the repo root.
- [ ] `CONTRIBUTING.md` covering the four frozen contract seams, the four-project typecheck, and — critically — the **undocumented hard prerequisite** that packaging needs a manually compiled static `whisper-cli` at `build/whisper-build/bin/whisper-cli` (brew builds are rejected as non-relocatable).
- [ ] Ship the FFmpeg GPL license text + written offer of source in the packaged app, and reconcile `docs/PACKAGING.md` with `scripts/bundle-binaries.mjs`.
- [ ] Add screenshots to `docs/`.

## Notes

Consider whether shipping a GPL ffmpeg inside an MIT app is the intended posture at all, or whether an LGPL build should be sourced instead — that is a licensing decision for the maintainer, not a mechanical fix.
