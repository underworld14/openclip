# Third-party components in the packaged app

OpenClip Desktop's own source is MIT (see `LICENSE`). The **packaged application
additionally ships native binaries and assets under other licences**, several of
which are copyleft. This file is the inventory. It covers what lands inside
`OpenClip.app`, not the full npm dev dependency tree.

`scripts/verify-package.mjs` asserts that the licence files below actually ship;
`scripts/bundle-binaries.mjs` refuses to stage a binary whose licence text is
missing or has been altered.

| Component                                                 | Licence                                                 | Ships at                         | Licence text                                                                |
| --------------------------------------------------------- | ------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| **FFmpeg / ffprobe**                                      | **GPL-3.0-or-later** (`--enable-gpl --enable-version3`) | `Resources/ffmpeg/<plat-arch>/`  | `build/licenses/ffmpeg/COPYING.GPLv3` + written offer in the same directory |
| **whisper.cpp** (`whisper-cli`)                           | MIT                                                     | `Resources/whisper/<plat-arch>/` | upstream: <https://github.com/ggml-org/whisper.cpp>                         |
| **yt-dlp**                                                | Unlicense (public domain)                               | `Resources/yt-dlp/<plat-arch>/`  | upstream: <https://github.com/yt-dlp/yt-dlp>                                |
| **onnxruntime-web** (WASM)                                | MIT                                                     | `Resources/onnx/`                | upstream: <https://github.com/microsoft/onnxruntime>                        |
| **YuNet** face-detection model                            | MIT                                                     | `Resources/onnx/`                | upstream: <https://github.com/opencv/opencv_zoo>                            |
| **DejaVu Sans**                                           | Bitstream Vera / DejaVu licence                         | `Resources/fonts/`               | `Resources/fonts/LICENSE-DejaVu.txt`                                        |
| **Anton, Archivo Black, Bebas Neue, Noto Emoji, Poppins** | SIL Open Font License 1.1                               | `Resources/fonts/`               | `Resources/fonts/OFL.txt` (provenance in `build/fonts/SOURCES.md`)          |
| **Electron / Chromium / Node.js**                         | MIT + Chromium's BSD-style terms                        | app framework                    | `Resources/LICENSES.chromium.html` (shipped by electron-builder)            |

## The FFmpeg situation, stated plainly

This is the part that actually constrains redistribution, so it should not be
buried:

- The bundled FFmpeg is **GPL-3.0-or-later**. `ffmpeg -L` on the shipped binary
  prints the GPLv3 notice; you can verify it yourself.
- OpenClip's own code stays MIT. The two licences do **not** merge here: OpenClip
  ships FFmpeg as an _unmodified, separately-licensed executable_ and invokes it
  by spawning a subprocess. It does not link against libav\*.
- FFmpeg is unmodified — the pinned SHA-256 values in
  `scripts/bundle-binaries.mjs` verify the downloaded artefacts byte-for-byte
  against the upstream build server on every package run.
- The GPL text and a written offer of source ship inside the app, next to the
  binaries, as GPL-3.0 §6 requires.

**If you fork and redistribute this app, those GPL obligations travel with you.**
If you would rather not carry them, `build/licenses/ffmpeg/README.md` describes
the LGPL alternative and the one thing to check before switching (whether the
libass `subtitles` filter the caption burn-in depends on survives dropping
`--enable-gpl`).

Deliberately **not** bundled: the `ffmpeg-static` / `ffmpeg-ffprobe-static` npm
packages. Those builds report `--enable-nonfree`, which is not redistributable at
all. `scripts/bundle-binaries.mjs` reads the binary's own `-buildconf` and fails
the build if it sees that flag, and `scripts/verify-package.mjs` byte-scans the
packaged bundle for the same marker.
