# Packaging OpenClip Desktop (macOS arm64)

This is the operational guide for producing a distributable OpenClip build. It
covers the **unsigned** build (which anyone can produce, no Apple account
needed) and the **signed + notarized** build (which requires _your_ Apple
Developer credentials — the CI/build machine cannot do this without them).

> Targets: macOS **Apple Silicon (arm64)** first (PRD §12.4). Electron 41.7.1,
> Node 24. Intel / Windows / Linux are v0.2.

---

## What gets bundled

The three native sidecars and the libass caption font are shipped as
`extraResources` (NOT inside `app.asar` — they must be spawnable/loadable from
disk) and resolved at runtime by `src/main/utils/paths.ts`:

| Bundled artifact                       | Lands at (inside `OpenClip.app`)                                   | Resolved in prod by   |
| -------------------------------------- | ------------------------------------------------------------------ | --------------------- |
| ffmpeg (static, libass + videotoolbox) | `Contents/Resources/ffmpeg/darwin-arm64/ffmpeg`                    | `ffmpegPath()`        |
| ffprobe (static)                       | `Contents/Resources/ffmpeg/darwin-arm64/ffprobe`                   | `ffprobePath()`       |
| whisper-cli (static, Metal-embedded)   | `Contents/Resources/whisper/darwin-arm64/whisper-cli`              | `whisperCliPath()`    |
| DejaVuSans.ttf (libass `fontsdir`)     | `Contents/Resources/fonts/DejaVuSans.ttf`                          | `fontsDir()`          |
| yt-dlp (standalone, no Python)         | `Contents/Resources/yt-dlp/darwin-arm64/yt-dlp`                    | `ytDlpPath()`         |
| YuNet model + onnxruntime-web wasm     | `Contents/Resources/onnx/`                                         | `reframeOnnxDir()`    |
| FFmpeg GPL licence + written offer     | `Contents/Resources/ffmpeg/darwin-arm64/{COPYING.GPLv3,README.md}` | — (legal, not loaded) |

GGML whisper **models are NOT bundled** (75 MB – 2.9 GB). They are downloaded on
first transcribe into `userData/models/` (PRD §13). This keeps the installer
under the 250 MB target (the unsigned dmg is ~211 MB).

The large binaries are **not committed to git**. `scripts/bundle-binaries.mjs`
stages them into `resources/`, and electron-builder runs it automatically via the
`beforePack` hook (`build/bundle-binaries.cjs`). Where each one comes from:

| Sidecar                                   | Source                                                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ffmpeg / ffprobe                          | **Downloaded**, pinned by build id and SHA-256-verified, from [Martin Riedl's FFmpeg Build Server](https://ffmpeg.martin-riedl.de/) |
| whisper-cli                               | **Built locally** by you — see the next section                                                                                     |
| yt-dlp                                    | **Downloaded**, pinned to a specific release tag and SHA-256-verified                                                               |
| ONNX (YuNet model + onnxruntime-web wasm) | Committed model + wasm copied from `node_modules`                                                                                   |

> **Not from `node_modules`.** The `ffmpeg-static` / `ffmpeg-ffprobe-static`
> packages report `--enable-nonfree`, which is **not redistributable** in a public
> dmg at all. They remain devDependencies for local testing only; the bundler
> reads the staged binary's own `-buildconf` and hard-fails if it sees that flag,
> and `verify-package.mjs` byte-scans the packaged bundle for the same marker.

The bundler also asserts the Gate-A invariants and fails loudly otherwise:

- ffmpeg exposes the libass `subtitles` filter + `h264_videotoolbox` encoder;
- every sidecar is **portable** (`otool -L` shows only `/usr/lib` + `/System/*`
  dylibs — no `@rpath`/brew libs), so notarization won't fail on an unsigned
  third-party dylib;
- the FFmpeg **GPL licence text and written offer of source** are staged next to
  the binaries (see below).

### FFmpeg is GPL-3.0-or-later, and its licence ships with it

The bundled ffmpeg/ffprobe are built `--enable-gpl --enable-version3`, which makes
them GPL-3.0-or-later — `ffmpeg -L` on the shipped binary prints the GPLv3 notice,
including "You should have received a copy of the GNU General Public License along
with ffmpeg".

So `build/licenses/ffmpeg/` (the verbatim GPL-3.0 text plus a written offer of
source and the exact build provenance) is staged into
`resources/ffmpeg/<plat-arch>/` and ships at
`Contents/Resources/ffmpeg/<plat-arch>/`. `bundle-binaries.mjs` verifies the
licence text against a pinned SHA so an edited or truncated copy fails the build,
and `verify-package.mjs` fails if it did not reach the `.app`.

OpenClip's own source stays MIT: it ships FFmpeg as an unmodified, separately
licensed executable and spawns it as a subprocess rather than linking against it.
See [`THIRD-PARTY-LICENSES.md`](../THIRD-PARTY-LICENSES.md) for the full inventory
and for the LGPL alternative if you would rather not carry GPL obligations.

### Building the static whisper-cli (one-time prerequisite)

`scripts/bundle-binaries.mjs` needs a relocatable, Metal-embedded whisper-cli at
`build/whisper-build/bin/whisper-cli` (or pointed to by
`OPENCLIP_WHISPER_CLI_SRC`). A brew `whisper-cli` is **rejected** (it links brew
dylibs and is not relocatable). Build it once:

```bash
git clone --branch v1.8.4 https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build --config Release
# then either:
mkdir -p /path/to/openclip/build/whisper-build/bin
cp build/bin/whisper-cli /path/to/openclip/build/whisper-build/bin/
# …or export OPENCLIP_WHISPER_CLI_SRC=/path/to/whisper.cpp/build/bin/whisper-cli
```

`-DGGML_METAL_EMBED_LIBRARY=ON` embeds the Metal kernels into the binary so we
do not need to ship `default.metallib` separately.

---

## 1) Unsigned build (no Apple account required)

This is what Stage 2 / Gate D produces — a runnable arm64 `.app` (and dmg) with
code signing disabled. It runs locally; macOS Gatekeeper will warn on first open
("unidentified developer") and the user must right-click → Open (or
`xattr -dr com.apple.quarantine OpenClip.app`). It is **not** distributable to
the public — for that you need notarization (section 2).

```bash
# .app + dmg (unsigned), arm64:
npm run build:mac:unsigned

# .app only (faster — no dmg), arm64:
npm run build:mac:unsigned:dir
```

Both scripts run `electron-vite build` then electron-builder with signing
explicitly disabled:

```
CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac [dmg] --arm64 -c.mac.identity=null
```

- `CSC_IDENTITY_AUTO_DISCOVERY=false` stops electron-builder from auto-picking a
  cert from the keychain.
- `-c.mac.identity=null` forces "no signing" (electron-builder logs
  `skipped macOS code signing  reason=identity explicitly is set to null`).

Artifacts:

- `dist/mac-arm64/OpenClip.app` (~535 MB on disk)
- `dist/openclip-desktop-2.0.0-arm64.dmg` (~211 MB)

The resulting `.app` is **ad-hoc (linker) signed** only — `codesign -dv` reports
`Signature=adhoc`, `TeamIdentifier=not set`. That is expected for an unsigned
build.

### Verify the unsigned bundle

```bash
npm run verify:package        # asserts the 3 sidecars exist + RUN from Contents/Resources, + font present
```

For the full end-to-end proof (the packaged .app boots and runs
import→transcribe(tiny)→captioned 1080×1920 export from `Contents/Resources`),
the Gate-D Playwright smoke:

```bash
# Needs a built .app + a tiny model staged at .smoke-cache/models/ggml-tiny.bin
npx playwright test tests/e2e/packaged-app.e2e.spec.ts
```

(The smoke skips gracefully if the .app or the model is absent.)

---

## 2) Signed + notarized build (requires YOUR Apple credentials)

Notarization **cannot be done in this environment** — it requires an Apple
Developer Program membership ($99/yr) and credentials that only you hold. Below
is exactly what you must provide and run.

### 2.1 Credentials you must supply

**a) Developer ID Application certificate** (for code signing). Created in your
Apple Developer account → Certificates → "Developer ID Application". Install the
`.cer` + its private key into your login keychain. Verify with:

```bash
security find-identity -v -p codesigning
# expect a line like:
#   1) ABCDEF0123... "Developer ID Application: Your Name (TEAMID1234)"
```

> In the Stage-2 build environment this returns **"0 valid identities found"** —
> hence the build is unsigned. Once you install the cert, electron-builder will
> auto-discover it (drop the `CSC_IDENTITY_AUTO_DISCOVERY=false` /
> `-c.mac.identity=null` overrides and run `npm run build:mac`).

**b) Notarization credentials.** The `afterSign` hook (`build/notarize.cjs`)
accepts either set (App Store Connect **API key preferred**):

_Option 1 — App Store Connect API key (recommended):_ create an API key in App
Store Connect → Users and Access → Integrations → App Store Connect API. Download
the `AuthKey_XXXX.p8` once. Then export:

```bash
export APPLE_API_KEY="/secure/path/AuthKey_T9GPZ92M7K.p8"   # path to the .p8
export APPLE_API_KEY_ID="T9GPZ92M7K"                         # the Key ID
export APPLE_API_ISSUER="aaaa-bbbb-cccc-dddd-eeee"           # the Issuer UUID
```

_Option 2 — Apple ID + app-specific password:_

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"     # appleid.apple.com → app-specific password
export APPLE_TEAM_ID="TEAMID1234"
```

In CI these go in repository secrets; never commit them. (The `.p8` for option 1
must be available as a file on the build machine.)

### 2.2 How the afterSign hook activates

`electron-builder.yml` sets `afterSign: build/notarize.cjs` and `mac.notarize:
false` (we use the hook, not electron-builder's built-in notarize path, so an
unsigned dev build is never _forced_ to notarize). The hook
(`build/notarize.cjs`):

1. runs only for `electronPlatformName === 'darwin'`;
2. calls `resolveCredentials(process.env)` — if **neither** credential set is
   present it logs `[notarize] skipping notarization (no credentials)` and
   returns (this is exactly what you see in the unsigned build);
3. with credentials present, lazily `require('@electron/notarize')` and calls
   `notarize({ appPath, ...creds })`, which submits the signed `.app` to Apple
   and waits for the ticket.

So the _only_ thing that flips the build from "unsigned" to "notarized" is:
(1) a Developer ID cert in the keychain, and (2) the notarization env vars set.
No code change is required.

### 2.3 The signing prerequisites already configured

- `mac.hardenedRuntime: true` (required for notarization).
- `build/entitlements.mac.plist` — `allow-jit`,
  `allow-unsigned-executable-memory` (Chromium/V8), and
  `allow-dyld-environment-variables` (to spawn sidecars with a controlled env).
  `disable-library-validation` is **deliberately omitted** because all three
  sidecars are self-contained (only `/usr/lib` + `/System/*`). If a future
  native-addon path (e.g. smart-whisper `.node`) is adopted, add
  `com.apple.security.cs.disable-library-validation` then.
- `asarUnpack: [resources/**, **/*.node]` and the `extraResources` mappings so
  ffmpeg/ffprobe/whisper-cli/fonts ship outside the asar and get signed.
- **All unpacked binaries must be signed** with the Developer ID or
  notarization fails ("invalid signature / Info.plist"). electron-builder signs
  the unpacked `extraResources` automatically when a real identity is present.

### 2.4 Produce + validate the notarized dmg

```bash
# With the cert in the keychain + notarization env vars exported:
npm run build:mac            # electron-vite build && electron-builder --mac
```

electron-builder will: sign the app + all unpacked binaries → run the
`afterSign` hook (notarize, waits for Apple) → build the dmg. After it
completes, **staple** the ticket so the app validates offline, and verify:

```bash
# Staple the notarization ticket onto the dmg (and/or the .app):
xcrun stapler staple "dist/openclip-desktop-2.0.0-arm64.dmg"

# Verify the staple + Gatekeeper acceptance:
xcrun stapler validate "dist/openclip-desktop-2.0.0-arm64.dmg"
spctl -a -vvv -t install "dist/openclip-desktop-2.0.0-arm64.dmg"   # → "accepted ... Notarized Developer ID"
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/OpenClip.app"
```

> electron-builder usually staples the `.app` automatically after a successful
> notarize; stapling the **dmg** is the manual step you run to ship a fully
> offline-verifiable installer.

A green `stapler validate` + `spctl` "accepted / Notarized" is the Gate-D
ship criterion (plan E.7).

---

## Troubleshooting

- **`arm64 requires signing, but identity is set to null`** — informational in
  an unsigned build; the `.app`/dmg still builds (ad-hoc signed). Expected.
- **whisper-cli not found at bundle time** — build the static whisper-cli (see
  above) or set `OPENCLIP_WHISPER_CLI_SRC`. A brew binary is rejected on
  purpose (non-relocatable).
- **Gatekeeper blocks the unsigned app** — right-click → Open, or
  `xattr -dr com.apple.quarantine dist/mac-arm64/OpenClip.app`. The proper fix
  is to notarize (section 2).
- **Notarization rejected for an invalid/unsigned dylib** — re-check
  `scripts/bundle-binaries.mjs`'s `otool -L` portability assertion; a sidecar
  linking a brew/`@rpath` dylib will fail. Rebuild it fully static.
