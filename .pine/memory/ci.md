---
topic: ci
updated: 2026-08-14T11:16:01Z
---

# ci

- 2026-08-09: A real-binary smoke must guard on the CAPABILITY it exercises, not on the binary merely being invokable. ffmpeg-static is a devDependency, so ffmpegAvailable() is true on EVERY CI runner — including Linux, where the same ffmpeg has no h264_videotoolbox (a macOS framework). The @serial export/caption smokes that omit forceCpu therefore ran and died with 'Unknown encoder' on the ubuntu gates job (CI run 31293580008). Use videotoolboxAvailable() from tests/harness/fixtures.ts for any spec that exports through the DEFAULT encoder; forceCpu/libx264 specs are portable. Corollary: ffmpeg-static and ffmpeg-ffprobe-static are NOT built in lockstep across platforms (5.3.0 = ffmpeg 6.0 on darwin-arm64 but 7.0 on linux-x64), so cross-package version assertions must be darwin-scoped. Also: youtube-dl-exec's postinstall hits the GitHub API, so every CI npm ci step needs GITHUB_TOKEN or it randomly 403s on the shared-IP rate limit.

- youtube-dl-exec's postinstall CANNOT be authenticated: `getBinary()` calls
  `fetch(url, headers)`, passing the header object as fetch's INIT argument, so the
  `Authorization` header is dropped and `GITHUB_TOKEN` is inert. Setting the token looks
  like it works because the unauthenticated 60/hr budget is shared per egress IP and often
  has room — it fails again later. Use `YOUTUBE_DL_SKIP_DOWNLOAD=1` on every CI `npm ci`
  instead: nothing in CI consumes that binary (`ytDlpPath()` returns the package's computed
  PATH CONSTANT without stat-ing it; the real-yt-dlp spec is gated on RUN_NETWORK_E2E plus a
  package-time-staged resources/yt-dlp/…). Tell the two apart by the error wording:
  "rate limit exceeded for <ip>" is unauthenticated, "for user ID <n>" is authenticated.
- 2026-08-14: The GPL-3.0 FFmpeg licence text and written offer live in build/licenses/ffmpeg/ and are staged next to the binaries by bundle-binaries.mjs; verify-package.mjs fails the build if they don't reach the .app. Never put prose that quotes '--enable-nonfree' inside app.asar — it trips the byte-scan guardrail meant to catch a real nonfree ffmpeg binary. (cites: scripts/bundle-binaries.mjs)
