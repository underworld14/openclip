# Bundled auto-reframe ONNX assets — sources & licenses

These files back **Part J (auto-reframe)**: a local, cross-platform 9:16 crop that
follows the speaker's face with **no native addon**. They are shipped under
`<Resources>/onnx/` (electron-builder `extraResources`) and resolved at runtime by
`src/main/utils/paths.ts → reframeOnnxDir()` (dev → repo `build/onnx`, prod →
`<resources>/onnx`). The face detector sets `ort.env.wasm.wasmPaths` to this
directory so `onnxruntime-web` loads its `.wasm` from beside the model.

## What lives here

| File | What | License | Committed? |
|------|------|---------|------------|
| `face_detection_yunet_2023mar.onnx` | YuNet face-detection model (OpenCV Zoo, 2023mar) | MIT | **yes** (small, ~227 KB) |
| `ort-wasm-simd-threaded.wasm` | `onnxruntime-web` WASM runtime (SIMD + threads) | MIT | **no** — copied at build time |
| `ort-wasm-simd-threaded.mjs` | `onnxruntime-web` WASM loader/glue for the above | MIT | **no** — copied at build time |
| `SOURCES.md` | this file | — | yes |

The `.wasm` + `.mjs` are LARGE (the wasm is ~13 MB) and are **NOT committed**.
`scripts/bundle-binaries.mjs` (run in dev and in the `beforePack` packaging hook)
copies them out of `node_modules/onnxruntime-web/dist/` into this directory, the
same reproducible "stage-from-node_modules, don't-commit" pattern used for
ffmpeg/ffprobe. `.gitignore` ignores `build/onnx/*.wasm` and `build/onnx/*.mjs`
while keeping the committed model + this file.

## Sources

### YuNet face-detection model (`face_detection_yunet_2023mar.onnx`)
- Project: OpenCV Zoo — `face_detection_yunet`
- License: **MIT**
- Source: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
- Direct file: https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx

The model has a FIXED `[1,3,640,640]` float32 NCHW input named `input` and emits 12
output tensors (`cls_{8,16,32}`, `obj_{8,16,32}`, `bbox_{8,16,32}`, `kps_{8,16,32}`).

### onnxruntime-web (`ort-wasm-simd-threaded.{wasm,mjs}`)
- Project: ONNX Runtime — `onnxruntime-web`
- Version: pinned by `package.json` (currently **1.26.0**)
- License: **MIT**
- Source: https://github.com/microsoft/onnxruntime
- npm: https://www.npmjs.com/package/onnxruntime-web

The bundled WASM is the **SIMD + multithreaded** build
(`ort-wasm-simd-threaded.*`). We load `onnxruntime-web/wasm` (the external-wasm
entry) and set `ort.env.wasm.wasmPaths` to this directory so the loader fetches
`ort-wasm-simd-threaded.wasm`/`.mjs` from beside the model rather than embedding or
fetching them from a CDN. Detection runs with `numThreads = 1` (single-threaded,
no cross-origin-isolation / SharedArrayBuffer requirement).

> When bumping `onnxruntime-web`, re-run `node scripts/bundle-binaries.mjs` to
> re-stage the matching `.wasm`/`.mjs` and update the version note above.
