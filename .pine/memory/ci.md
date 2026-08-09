---
topic: ci
updated: 2026-08-09T04:14:53Z
---

# ci

- 2026-08-09: A real-binary smoke must guard on the CAPABILITY it exercises, not on the binary merely being invokable. ffmpeg-static is a devDependency, so ffmpegAvailable() is true on EVERY CI runner — including Linux, where the same ffmpeg has no h264_videotoolbox (a macOS framework). The @serial export/caption smokes that omit forceCpu therefore ran and died with 'Unknown encoder' on the ubuntu gates job (CI run 31293580008). Use videotoolboxAvailable() from tests/harness/fixtures.ts for any spec that exports through the DEFAULT encoder; forceCpu/libx264 specs are portable. Corollary: ffmpeg-static and ffmpeg-ffprobe-static are NOT built in lockstep across platforms (5.3.0 = ffmpeg 6.0 on darwin-arm64 but 7.0 on linux-x64), so cross-package version assertions must be darwin-scoped. Also: youtube-dl-exec's postinstall hits the GitHub API, so every CI npm ci step needs GITHUB_TOKEN or it randomly 403s on the shared-IP rate limit.
