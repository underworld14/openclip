# FFmpeg — license and written offer of source

OpenClip Desktop is MIT-licensed, but it **bundles and executes FFmpeg**, which
is not. This directory carries FFmpeg's own licence and the written offer of
source that redistributing it requires. `scripts/bundle-binaries.mjs` stages
these files next to the binaries so they ship inside the packaged app at
`OpenClip.app/Contents/Resources/ffmpeg/<plat-arch>/`, and
`scripts/verify-package.mjs` fails the build if they are missing.

## What is bundled, and under what licence

The bundled `ffmpeg` and `ffprobe` are built with `--enable-gpl` **and**
`--enable-version3`. That combination makes the resulting binaries

> **GNU General Public License, version 3 or later (GPL-3.0-or-later).**

The binaries say so themselves — `ffmpeg -L` prints the GPLv3 notice, including
the line "You should have received a copy of the GNU General Public License
along with ffmpeg". `COPYING.GPLv3` in this directory _is_ that copy.

Note the two licences do not merge. OpenClip's own source stays MIT; FFmpeg
stays GPL-3.0-or-later. They are separate works: OpenClip ships FFmpeg as an
unmodified executable and talks to it by spawning a subprocess, never by linking
against it.

## Provenance of the exact binaries

They are downloaded, pinned and SHA-256-verified by
`scripts/bundle-binaries.mjs` from **Martin Riedl's FFmpeg Build Server**:

- Source of builds: <https://ffmpeg.martin-riedl.de/>
- Build id: see `FFMPEG_MR_BUILD` in `scripts/bundle-binaries.mjs`
- Download: `https://ffmpeg.martin-riedl.de/download/macos/<arch>/<build>/{ffmpeg,ffprobe}.zip`
- Build detail page (lists the full configure line and every component version):
  `https://ffmpeg.martin-riedl.de/info/detail/macos/<arch>/<build>`

The build is deliberately **not** `--enable-nonfree`; the bundling script reads
the binary's own `-buildconf` and refuses to package a `--enable-nonfree` build,
because such a build cannot be legally redistributed at all. This is why the app
does not use the `ffmpeg-static` npm package.

## Written offer of source

The complete corresponding source code for the bundled FFmpeg binaries is
publicly available from the FFmpeg project:

- <https://git.ffmpeg.org/ffmpeg.git> (tag matching the version in the build id)
- <https://ffmpeg.org/download.html>

In addition, and to satisfy GPL-3.0 §6 for anyone who prefers to receive it from
us directly: **for a period of three years from the date OpenClip distributed
this binary, we will provide, to any third party who asks, a complete
machine-readable copy of the corresponding source code for the bundled FFmpeg,
on a medium customarily used for software interchange, for no more than our cost
of physically performing the distribution.** Requests may be sent by opening an
issue at <https://github.com/underworld14/openclip/issues> with the subject
"FFmpeg source request", quoting the build id printed above.

No modifications are made to FFmpeg by this project — the bundled binaries are
byte-for-byte the upstream build server's artefacts, which is what the pinned
SHA-256 values in `scripts/bundle-binaries.mjs` verify on every package run.

## If you would rather not ship GPL code

Bundling a GPL-3.0 FFmpeg inside an MIT application is a deliberate posture, not
an accident, and it is a decision the maintainer owns. The alternative is to
source an **LGPL** build (drop `--enable-gpl`), which loses some filters — check
whether the libass `subtitles` filter the caption burn-in depends on survives
that configuration before switching. See `docs/PACKAGING.md`.
