# Auto‑Reframe (Speaker‑Following Vertical Crop) — Design

> **Status: DEFERRED design.** This documents a planned feature for a future part. It is **not implemented** in Part I. It exists so the work is scoped, the trade‑offs are recorded, and a later round can pick it up without re‑discovery.

## Why
Today OpenClip exports vertical clips with a **static center‑crop**: `ffmpeg-export.ts → cropExpr(aspect)` emits `crop=ih*9/16:ih` (a fixed column down the middle), then `scale=1080:1920`. When the speaker isn't centered — interviews, two‑person podcasts, off‑center framing — the crop cuts off faces and looks amateur.

The single feature that most defines OpusClip (and supoclip) is **auto‑reframe**: the vertical crop *follows the active speaker's face*, and for two‑person shots it either **pans** between speakers or renders a **split‑screen** stack. This doc plans bringing that to our local, no‑cloud, Electron/TS app.

## What supoclip does (reference)
supoclip is Python and leans on OpenCV + MediaPipe (`backend/src/video_utils.py`). The pieces worth porting conceptually:

- **`detect_faces_in_clip(path, start, end)`** — samples frames (~every 0.5s), runs **MediaPipe FaceDetection** (falls back to OpenCV DNN, then Haar), returns per‑frame face boxes + confidence; outliers filtered for temporal consistency.
- **`detect_optimal_crop_region(...)`** — aggregates face centers → a single face‑centered crop window (static per clip). Falls back to center‑crop when no faces.
- **`detect_speaker_reframe_plan(clip, output_format)`** — for wide (`w/h > 1.2`), low‑scene‑cut clips with **two** face clusters: builds either a **pan** plan (an ffmpeg `crop=…:x='<time‑varying expr>'` driven by which side has more motion = the likely active speaker, derived via `tblend`/`signalstats` motion metadata) or a **split** plan (`split → crop each → vstack` into 1080×1920).
- **`render_reframed_clip_ffmpeg(...)`** — applies the chosen filtergraph (`crop=…:x='<expr>',scale=1080:1920` for pan; `split/crop/vstack` for split; copy for original).

Output is always 1080×1920, libx264, faststart.

## Our constraints
- **Local‑only, no cloud** (PRD): no AssemblyAI/cloud face APIs. Detection must run on‑device.
- **TS/Electron, not Python**: we already ship native sidecars (whisper‑cli, ffmpeg/ffprobe) via `extraResources` (see `docs/PACKAGING.md`). Adding a face model means another bundled artifact + macOS notarization surface.
- **Determinism + testability**: our services are pure where possible with injected runners (e.g. `url-download.faststartRemux`, `ffmpeg-export.exportClipArgs`). A reframe stage should keep the same shape: a **pure plan builder** + an **injected detector/runner**.

## Approach options
| | Approach | Detection | Pros | Cons |
|---|---|---|---|---|
| **A (recommended)** | **Bundled ONNX face detector run from Node** | `onnxruntime-node` + a small face‑detection model (e.g. an UltraFace/YuNet‑class ONNX, a few MB) run on frames extracted via ffmpeg | Pure‑JS integration, no Python runtime, model is just a file under `extraResources`; cross‑platform | New native dep (`onnxruntime-node` prebuilds) adds packaging weight + a notarization/signing surface; per‑frame decode cost |
| **B** | **Bundled Python sidecar** (OpenCV + MediaPipe), closest to supoclip | MediaPipe FaceDetection | Most faithful port; battle‑tested detection | Ships a Python runtime/venv or a PyInstaller binary — large, slow to notarize, heavier maintenance than our current sidecars |
| **C (fallback)** | **ffmpeg‑only saliency/motion heuristic** | none (no face model) | Zero new deps; reuses existing ffmpeg; cheap | Not true face tracking — approximates "where the action is" via crop‑region motion (`tblend`/`signalstats`), like supoclip's pan‑activity signal but without knowing it's a face. Lower accuracy, can lock onto motion that isn't the speaker |

**Recommendation:** **A** as the primary path, with **C** as a graceful fallback when the model is unavailable or detection is low‑confidence (so reframe never hard‑fails — it degrades to today's center‑crop or a motion heuristic).

## Proposed architecture (when built)
A new **pre‑export "reframe plan" stage**, mirroring the existing pure‑core + injected‑runner pattern:

1. **`reframe-detect.ts` (main, injected runner)** — extract sample frames for a clip span (ffmpeg `-vf fps=2,scale=…`), run the detector (ONNX in A; ffmpeg motion in C), return per‑sample face centers/confidence (or motion centroids). Injectable so unit tests pass canned detections — no model/binary in tests.
2. **`reframe-plan.ts` (pure, shared/main)** — `buildReframePlan(samples, sourceWxH, targetAspect, mode)` →
   - `{ mode: 'static', cropX }` (single‑face / one cluster),
   - `{ mode: 'pan', cropW, xExpr }` (time‑varying `x` expression for `crop`),
   - `{ mode: 'split', regions }` (two clusters → vstack), or
   - `null` (fall back to center‑crop).
   Pure + fully unit‑tested (cluster → region math, pan smoothing, hysteresis to avoid jitter).
3. **`ffmpeg-export.buildVf` extension** — accept an optional reframe plan and emit the crop **ahead of `scale`**: `crop=<W>:<H>:x='<expr>':y=0,scale=1080:1920[,subtitles=…]` for pan, or the `split/crop/vstack` `-filter_complex` for split. The single static center‑crop stays the default when no plan.
4. **Wiring** — a `reframe` option on `JobParams['export']` (`'off' | 'face' | 'auto'`); `export-runner` builds the plan (cached per clip) before `exportClip`. UI: a "Reframe" select in `ExportPanel`.

## Interactions / risks to resolve at build time
- **Captions:** karaoke burn (`ass-captions`) is positional in the 1080×1920 canvas — reframe changes *which source pixels* fill that canvas but not the caption canvas, so captions are unaffected. Split‑screen (two stacked 540‑tall tiles) may need caption `MarginV` tuning.
- **Jump‑cuts (Part I.4):** if silence removal lands first, the reframe `xExpr` must be expressed on the **compressed** timeline (post‑`setpts`). Plan builder must consume keep‑ranges‑aware sample times.
- **Performance:** per‑frame detection on long sources is expensive — sample sparsely (≈2 fps) and interpolate; cache the plan per clip id + bounds.
- **Packaging/notarization (A):** validate `onnxruntime-node` prebuilds are signable and pass `verify:package` + Gate‑D on the unsigned/`mac` builds; document the added size in `docs/PACKAGING.md`.
- **Quality gates:** static center‑crop must remain the deterministic default; reframe is opt‑in and must degrade to it on any detector failure.

## Out of scope for this design
Diarization‑driven speaker labels, B‑roll, multi‑face (>2) layouts. Those are separate features.
