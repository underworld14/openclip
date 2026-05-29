# Product Requirements Document (PRD)
## OpenClip Desktop — Open Source AI Video Clipping Tool
### Version: 2.0.0 | Status: Reviewed & Re-scoped | Date: 2026-05-29

> **Changelog v1.0.0 → v2.0.0** (verificator + architect pass): Native-first sidecar strategy (no Python in MVP — `whisper.cpp` + FFmpeg binaries); Electron bumped 34 → 41; honest re-scope (lean MVP + minimal timeline as the real first release, advanced features moved to dated later versions); strict-JSON AI integration (OpenAI `json_schema`, Anthropic `messages.parse`); ASS/libass karaoke captions; `safeStorage` instead of keytar; MessagePort-based streaming job IPC; and **new sections** for binary distribution, model download, GPU fallback, macOS notarization, BYOK cost/token budgeting, job queue + temp-file lifecycle, and testing strategy. See the section list (§13–§18) for the new material.

---

## 1. Executive Summary

**OpenClip Desktop** adalah aplikasi desktop open-source yang memungkinkan user mengunggah video panjang (podcast, vlog, webinar, interview) dan secara otomatis mendeteksi "viral moments" menggunakan AI, lalu meng-convertnya menjadi short-form clips (9:16) dengan auto-caption, dan brand template — **100% lokal processing untuk video**, **BYOK (Bring Your Own Key)** untuk AI API.

**Key Differentiator:**
- Video processing lokal di PC (tidak upload video ke cloud)
- Hanya **transcript/teks** yang dikirim ke AI (murah, cepat, private) — bukan audio, bukan video
- BYOK AI API — user pakai API key sendiri (OpenAI, Claude, Gemini, Ollama)
- Open source & self-hostable server opsional (fase lanjutan, repo terpisah)
- **Native-first**: tidak ada runtime Python yang perlu di-bundle — transkripsi pakai `whisper.cpp` (binary), video pakai FFmpeg (binary). Install kecil, mudah di-ship, sedikit bug cross-platform.

---

## 2. Product Vision

> "Every creator deserves a private, local, AI-powered video editor that turns long content into viral shorts without uploading sensitive footage to the cloud."

---

## 3. Target Users

| Persona | Need | Pain Point |
|---------|------|------------|
| **Solo Creator** | Turn 1 long video into 5–10 shorts | Manual editing takes 4–6 hours |
| **Podcast Editor** | Clip best moments for promotion | Hard to find "gold moments" in 2hr+ audio |
| **Agency / Team** | Bulk process client videos | Expensive SaaS subscriptions ($50–200/mo) |
| **Privacy-Conscious** | Edit sensitive/internal videos | Cloud tools require video upload |

---

## 4. Tech Stack

### 4.1 Desktop Application (Electron)

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Framework** | Electron **41.x** | Cross-platform desktop shell (macOS-first; Win/Linux v0.2) |
| **Frontend** | React 19 + TypeScript | UI components, timeline, preview |
| **Styling** | Tailwind CSS **v4** + shadcn/ui | Consistent design system |
| **State Management** | Zustand | Global state (projects, clips, settings) |
| **Dev/Build** | **electron-vite** | Three-process Vite config (main/preload/renderer), HMR, externalized native deps |
| **Packaging** | **electron-builder** | dmg/extraResources/asarUnpack, code-signing + notarization |
| **IPC** | Electron IPC + **MessagePort-per-job** | Request/response control plane + streaming progress for long jobs |
| **Auto Updater** | electron-updater | Delta updates (added in the v1.0 polish phase) |

> **Why native-first?** Bundling Python (faster-whisper, pyannote, librosa, MediaPipe, scenedetect) means either an embedded interpreter + ~GBs of pip deps or PyInstaller executables (~500MB each) — a large bundle and a cross-platform packaging/notarization minefield. Verified (2026-05): `whisper.cpp`'s `whisper-cli` provides word-level timestamps (`-ml 1`), JSON output, and **Metal + Core ML acceleration on Apple Silicon** — so we spawn it exactly like FFmpeg and skip Python entirely for the MVP.

### 4.2 Local Processing Engine (Main Process / Node.js)

| Component | Technology (v2) | Purpose | Status |
|-----------|-----------------|---------|--------|
| **Video Processing** | FFmpeg (bundled static binary) | Cut, reframe, burn captions, overlay | MVP |
| **Audio Extraction** | FFmpeg | Extract 16kHz mono WAV for transcription | MVP |
| **Transcription** | **whisper.cpp `whisper-cli`** (bundled binary) | Local STT, word-level timestamps, Metal/Core ML | MVP |
| **Sidecar Host** | Electron **`utilityProcess`** | Isolates native crashes from the UI; spawns FFmpeg/whisper | MVP |
| **Local LLM** | Ollama (optional, user-installed) | Offline AI analysis, no API key | MVP (optional) |
| **Face/Subject Tracking** | **ONNX Runtime** (Node) | Smart 9:16 reframe (NOT MediaPipe-Python) | v0.3 |
| **Speaker Diarization** | **sherpa-onnx** (no HuggingFace token) | "who spoke when" | v0.4 |
| **Scene / Audio analysis** | FFmpeg filters / ONNX | Scene detect, silence, energy | v0.6 |

> **Transcription fallback:** if the bundled-CLI path underperforms, `smart-whisper` (native Node addon with prebuilt Metal binaries + built-in model manager) is the drop-in alternative. CLI is primary because it sidesteps native-addon ABI rebuilds and `.node` notarization-signing complexity.

### 4.3 AI Integration (BYOK — Cloud API)

| Provider | Models (verify exact IDs at build time) | Structured Output Mode | Use Case |
|----------|------------------------------------------|------------------------|----------|
| **Anthropic** | Claude 4.x family (Opus/Sonnet/Haiku) | SDK `messages.parse` + `zodOutputFormat` | Long transcript analysis, hook detection |
| **OpenAI** | Current-gen GPT (`gpt-4o`-class or newer) | `response_format: json_schema` (strict) | Viral moment detection, title generation |
| **Google** | Gemini current-gen | Schema-constrained JSON | Multimodal (later) |
| **Local** | Llama / Mistral / Qwen via **Ollama** | `format: <jsonSchema>` (grammar-constrained) | Fully offline AI |

> Model IDs change frequently — the implementation resolves current model names via provider docs (`ctx7` / official docs) at build time rather than hardcoding stale ones. **All providers now support real structured output** — the v1 PRD's OpenAI `json_object` was the weak legacy mode and the Anthropic "force-a-tool" hack is superseded by `messages.parse`.

### 4.4 Optional Server (Self-Hosted) — **deferred to a separate repo, post-1.0**

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **API** | FastAPI (Python) or Express (Node.js) | Team sync, cloud backup |
| **Database** | PostgreSQL | User accounts, project metadata |
| **Storage** | MinIO (S3-compatible) | Cloud backup of projects |
| **Queue** | Redis + BullMQ | Async export job processing |

> The server is intentionally **out of the desktop app's scope and repo** to avoid scope creep. It ships only after the desktop app is stable.

### 4.5 Development & Build Tools

| Tool | Purpose |
|------|---------|
| **electron-builder** | Package & distribute (dmg first) |
| **GitHub Actions** | CI/CD (macOS arm64 first; matrix in v0.2) |
| **Vitest** | Unit / integration testing (the bulk) |
| **Playwright** | Thin E2E (launch → import → export) |
| **Sentry** | Error tracking (opt-in only) |

---

## 5. Core Features & Modules

### 5.1 Feature Matrix (re-prioritized)

| Feature | Release | Local/Cloud | Complexity |
|---------|---------|-------------|------------|
| Video Import (file/URL) | **MVP** | Local | Low |
| Audio Extraction | **MVP** | Local | Low |
| Transcription (whisper.cpp) | **MVP** | Local | Medium |
| AI Viral Clip Detection | **MVP** | Cloud (BYOK) | Medium |
| Video Cutting (FFmpeg) | **MVP** | Local | Low |
| 9:16 Reframe (center-crop) | **MVP** | Local | Low |
| Auto Caption (burned, karaoke) | **MVP** | Local | Medium |
| Project Save/Load | **MVP** | Local | Low |
| Minimal Timeline (preview + trim) | **MVP** | Local | Medium |
| Cross-platform (Win/Linux) | v0.2 | Local | Medium |
| Face Tracking (smart reframe) | v0.3 | Local | High |
| Speaker Diarization | v0.4 | Local | High |
| Brand Templates + Batch Export | v0.5 | Local | Medium |
| Full Timeline (multi-track, split, waveform, undo) | v0.6 | Local | High |
| Scene Detection / Audio Enhancement | v0.6 | Local | Medium |
| Title/Hook Generator + Auto-updater | v1.0 | Local + Cloud | Medium |
| Team Sync / Cloud (separate repo) | Future | Server | High |
| Manual "Open in browser" publish handoff | Future | Cloud | Low |

> **Dropped/demoted from v1:** "Auto Publish to Social" — OAuth + per-platform TOS churn for low payoff. Replaced by a manual *open-in-browser-with-file-ready* handoff. "Audio Enhancement" deferred. Full timeline split into "minimal" (MVP) and "full" (v0.6).

---

## 6. Detailed Feature Specifications

### 6.1 MODULE: Video Import — MVP

**User Story:** As a creator, I want to import a long video so the app can process it into clips.

**Acceptance Criteria:**
- [ ] Drag & drop video files (`.mp4`, `.mov`, `.mkv`, `.avi`)
- [ ] Paste YouTube/URL → download via bundled **yt-dlp** (with a one-time **TOS/usage warning** dialog; see §20.4)
- [ ] Validate format and show metadata (duration, resolution, fps) via **ffprobe**
- [ ] Auto-extract audio (16kHz mono WAV) using FFmpeg
- [ ] Progress bar during import

**FFmpeg Command (Audio Extraction):**
```bash
ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 audio.16k.wav
```

---

### 6.2 MODULE: Transcription (whisper.cpp) — MVP

**User Story:** As a creator, I want the app to transcribe the video so I can search content and generate captions.

**Acceptance Criteria:**
- [ ] Runs locally via bundled `whisper-cli` (Metal/Core ML on Apple Silicon)
- [ ] Word-level timestamps (start/end per word) via `-ml 1`
- [ ] Segment-level timestamps (start/end per sentence)
- [ ] Confidence per word/segment
- [ ] Multi-language (auto-detect)
- [ ] Transcript in a searchable sidebar
- [ ] Export transcript as SRT/VTT/JSON
- [ ] **First-run model download UX** (models not bundled; see §13)

**Whisper Model Selection (GGML):**
| Model | Rel. Speed | Accuracy | Size (GGML) | Use Case |
|-------|-----------|----------|-------------|----------|
| tiny | ~10x | Low | ~75 MB | Quick testing |
| base | ~7x | Fair | ~140 MB | Fast draft (MVP default) |
| small | ~4x | Good | ~460 MB | Balanced |
| medium | ~2x | Better | ~1.5 GB | Production |
| **turbo** | ~6x | Near-large | ~1.5 GB | **Best speed/quality balance** |
| large-v3 | 1x | Best | ~2.9 GB | Best quality |

**Invocation (spawned from the sidecar host):**
```bash
whisper-cli -m <userData>/models/ggml-base.bin \
  -f audio.16k.wav \
  --output-json --max-len 1 \
  -pp   # print progress for streaming
# JSON (with word timestamps) is parsed from the output file.
```

---

### 6.3 MODULE: AI Viral Clip Detection — MVP

**User Story:** As a creator, I want AI to find the best moments so I don't have to watch it all.

**Acceptance Criteria:**
- [ ] Format **segment-level** transcript + timestamps into the LLM prompt (word data stays local for captions — saves ~10× tokens)
- [ ] For long videos, **chunk + map-reduce** (see §16) so a 2hr transcript never overflows the context window
- [ ] Send to the user's chosen provider (BYOK) using **provider-native structured output**
- [ ] LLM returns validated JSON (Zod) with clip suggestions (start, end, title, score, hook, type, keywords)
- [ ] **Repair ladder** on invalid JSON (see §16); clamp/dedupe overlapping spans in code
- [ ] Display clips in the sidebar with virality score
- [ ] Regenerate with a different prompt/style
- [ ] Clip style presets (funny, educational, controversial, emotional, motivational, storytelling, all)

**Prompt library: see §7.**

---

### 6.4 MODULE: Auto Caption Generation (Karaoke) — MVP

**User Story:** As a creator, I want auto-generated captions burned into my clips so they're social-ready.

**Acceptance Criteria:**
- [ ] Captions generated from word-level timestamps
- [ ] **Word-level karaoke highlight** rendered via an **`.ass` file with `\k` tags** (libass), NOT per-word `drawtext`
- [ ] Customizable font, color, position, background → mapped to ASS `Style:` / `force_style`
- [ ] Animation: pop-in / fade / typewriter (ASS-native)
- [ ] (Per-speaker colors → v0.4 with diarization)

**Caption Rendering (FFmpeg + libass):**
```bash
ffmpeg -i clip.mp4 -vf "subtitles=clip.ass" -c:v h264_videotoolbox -c:a aac out.mp4
```
`clip.ass` example cue: `{\k20}Hello {\k35}World` (centiseconds per word for the karaoke fill).

---

### 6.5 MODULE: 9:16 Reframe — MVP (center-crop) → v0.3 (smart/face)

**User Story:** As a creator, I want my 16:9 video reframed to 9:16 for TikTok/Reels/Shorts.

**MVP Acceptance Criteria (center-crop):**
- [ ] Center-crop to 9:16, scale to 1080×1920
- [ ] Support 1:1 and 4:5 ratios

**v0.3 Acceptance Criteria (smart reframe):**
- [ ] Auto-detect main subject via **ONNX Runtime** face/subject detection
- [ ] Keep subject centered with **smoothed** camera movement
- [ ] Manual override to track a specific region

**FFmpeg Reframe (Center Crop — MVP):**
```bash
ffmpeg -i input.mp4 -vf "crop=ih*9/16:ih,scale=1080:1920" -c:v h264_videotoolbox output.mp4
```

---

### 6.6 MODULE: Timeline Editor — Minimal (MVP) → Full (v0.6)

**User Story:** As a creator, I want to manually adjust clip boundaries.

**MVP (Minimal) Acceptance Criteria:**
- [ ] Preview window with HTML5 `<video>` scrubbing of the source
- [ ] Two drag handles to adjust clip start/end (writes `editedStart`/`editedEnd`)
- [ ] Export honors the edited bounds
- [ ] Keyboard: `Space` play/pause, `I` mark in, `O` mark out

**v0.6 (Full):** multi-track (video/audio/caption), split tool, audio waveform, frame-accurate scrubbing, undo/redo, zoom, full shortcut set.

---

### 6.7 MODULE: Speaker Diarization — v0.4

**User Story:** As a creator, I want to know who is speaking when.

**Acceptance Criteria:** detect speakers, label "Speaker A/B…", show in transcript, per-speaker caption colors, manual rename.
**Technology:** **sherpa-onnx** (ONNX speaker models) — chosen over pyannote.audio to avoid the **HuggingFace gated-model auth token** (bad first-run UX) and the Python runtime.

### 6.8 MODULE: Brand Templates — v0.5

Logo (PNG w/ alpha), brand colors/fonts, intro/outro, lower-thirds/subscribe overlay, saved presets, batch apply.

### 6.9 MODULE: Export & Publish — MVP (export) / Future (publish handoff)

**Acceptance Criteria:**
- [ ] Export MP4 (H.264); MOV/ProRes & WebM later
- [ ] Quality presets 720p/1080p (4K later)
- [ ] Batch export (v0.5)
- [ ] Export with metadata (title, description, tags)
- [ ] Export project file (`.ocproj` JSON) for backup/sharing
- [ ] **Future:** manual handoff — open the platform's upload page in the browser with the file ready (no OAuth/auto-post)

---

## 7. AI Prompts Library

> Output is now enforced by provider-native structured output + a Zod schema (§16); the system prompt still asks for clean JSON as a belt-and-suspenders measure.

### 7.1 System Prompt: Viral Clip Detector

```
You are ViralClipGPT, an expert video editor and viral content strategist with 10+ years of experience creating short-form content for TikTok, YouTube Shorts, and Instagram Reels.

Your task is to analyze a video transcript with timestamps and identify the most engaging moments that would perform well as viral short clips.

GUIDELINES FOR DETECTING VIRAL MOMENTS:
1. HOOKS: Strong opening statements, controversial opinions, or surprising facts in the first 3 seconds of a segment
2. EMOTIONAL PEAKS: High emotional intensity (anger, joy, sadness, excitement)
3. "AHA" MOMENTS: Insights, revelations, or counter-intuitive information
4. STORY CLIMAX: The peak of a narrative arc (problem -> tension -> resolution)
5. QUOTABLE QUOTES: Memorable one-liners or powerful statements
6. CONTROVERSY: Debates, disagreements, or challenging mainstream beliefs

AVOID:
- Filler words ("um", "uh", "like", "you know", "basically")
- Long pauses or dead air
- Repetitive explanations
- Topic transitions without a hook

CLIP REQUIREMENTS:
- Duration: 15-90 seconds each
- A clear beginning, middle, and end; complete without full-video context
- Prioritize clips that START with a hook, not a setup

OUTPUT: Return ONLY a valid JSON object matching the provided schema. No markdown, no prose.

{
  "clips": [
    {
      "start_time": 45.20,
      "end_time": 78.50,
      "title": "Catchy Title Under 60 Characters",
      "hook": "One sentence explaining why this moment is engaging",
      "virality_score": 9,
      "clip_type": "hook|emotional|aha|story|quote|controversy|visual",
      "keywords": ["keyword1", "keyword2"],
      "suggested_caption": "Short caption for social media post",
      "hashtags": ["#hashtag1", "#hashtag2"]
    }
  ],
  "analysis": {
    "total_duration": 3600,
    "clips_found": 5,
    "best_clip_index": 2,
    "overall_virality_potential": "high|medium|low"
  }
}
```

### 7.2 User Prompt: Standard Analysis

```
Analyze the following video transcript and identify the best viral clip moments.

VIDEO METADATA:
- Title: {video_title}
- Duration: {duration} seconds
- Category: {category}
- Target Platform: {target_platform}

TRANSCRIPT (segment-level, with timestamps):
{transcript}

CLIP STYLE PREFERENCE: {clip_style}
Options: funny, educational, controversial, emotional, motivational, storytelling, all

NUMBER OF CLIPS REQUESTED: {num_clips}

Return JSON per the schema. All timestamps are absolute seconds from the start of the full video.
```

### 7.3 Clip Style Variations

**Funny:** humor, wit, unexpected punchlines, funny reactions, comedic timing, self-deprecation.
**Educational:** "did you know", counter-intuitive facts, step-by-step with examples, myth vs reality, actionable tips.
**Controversial:** hot takes, "everyone is wrong about…", debates, challenging norms, bold predictions.
**Emotional:** vulnerability, overcoming adversity, heartwarming moments, passionate rants, nostalgia.

### 7.4 Title & Hook Generator

```
Based on the clip transcript, generate 5 alternative titles and hooks.
CLIP TRANSCRIPT: {clip_transcript}
For each: Title (max 60 chars), Hook (1-2 scroll-stopping sentences), and the psychological trigger used.
Format as JSON: { "options": [ { "title": "...", "hook": "...", "psychology": "curiosity_gap|fomo|social_proof|controversy|empathy|urgency" } ] }
```

### 7.5 Caption Enhancement

```
Enhance the transcript into social-ready captions with emojis and keyword emphasis.
RULES: max 1 emoji / 5 words; ALL CAPS for key words; short punchy sentences; line breaks; match the tone.
INPUT: {transcript}
OUTPUT: { "enhanced_captions": [ { "start_time": 0.0, "end_time": 3.5, "text": "🔥 You won't BELIEVE what happened next..." } ] }
```

### 7.6 Content Summarization

```
Summarize the transcript.
OUTPUT: { "summary": "2-3 paragraphs", "key_points": ["..."], "topics": ["..."], "sentiment": "positive|negative|neutral|mixed", "speaker_count": 2, "language": "en" }
```

---

## 8. Glossary: Istilah-istilah untuk Pemula

### 8.1 Transcription & Audio

| Istilah | Definisi | Analogi Sederhana |
|---------|----------|-------------------|
| **Transcription** | Mengubah audio jadi teks | Mengetik ulang apa yang orang bicarakan |
| **Word-Level Timestamp** | Waktu start/end SETIAP kata | Subtitle karaoke yang menyala per kata |
| **Segment-Level Timestamp** | Waktu start/end satu kalimat | Subtitle film per baris |
| **STT (Speech-to-Text)** | Teknologi suara → teks | Google Voice Typing |
| **Whisper** | Model AI OpenAI untuk STT | "Telinga AI" yang transkrip bahasa apa saja |
| **whisper.cpp** | Implementasi Whisper di C/C++ — cepat, tanpa Python, jalan di GPU/Metal | Whisper versi "ringan & native" |
| **whisper-cli** | Program command-line dari whisper.cpp yang kita panggil | "Mesin transkrip" yang dipanggil app |
| **Core ML / Metal** | Akselerasi AI di chip Apple Silicon | "Turbo" khusus Mac M-series |
| **VAD** | Deteksi bagian audio yang ada suara vs diam | Sensor yang tahu kapan ada orang bicara |
| **Sample Rate** | Sample audio per detik (16,000 Hz) | Resolusi foto — makin tinggi makin detail |
| **PCM / WAV** | Audio mentah / container standar | File TXT-nya audio |
| **Diarization** | Mengenali "siapa bicara kapan" | Memberi label "Orang A/B" di transcript |

### 8.2 Video Processing

| Istilah | Definisi | Analogi |
|---------|----------|---------|
| **FFmpeg** | CLI manipulasi video/audio | "Swiss Army Knife" untuk video |
| **ffprobe** | Membaca metadata video (durasi, resolusi, fps) | "Pemeriksa identitas" file video |
| **FPS / Resolution / Aspect Ratio** | Frame per detik / ukuran pixel / perbandingan WxH | Kecepatan flipbook / ukuran kertas / orientasi foto |
| **Reframe** | Ubah aspect ratio (16:9 → 9:16) | Memotong foto landscape jadi portrait |
| **Crop / Pad / Scale** | Potong / tambah bingkai / ubah ukuran | Gunting / bingkai putih / zoom |
| **Burn Subtitles** | Tulis subtitle PERMANEN ke video | Spidol permanen di foto |
| **ASS (Advanced SubStation Alpha)** | Format subtitle kaya gaya (warna, posisi, **karaoke**) | "SRT super" untuk efek karaoke |
| **libass** | Mesin render ASS di dalam FFmpeg | "Tukang gambar" subtitle bergaya |
| **Frame-accurate cut** | Potong tepat di frame yang diminta (perlu re-encode) | Potong tepat di garis vs di lipatan terdekat |
| **Hardware Acceleration** | Pakai GPU encode (`h264_videotoolbox` di Mac, NVENC di NVIDIA) | Pakai mesin vs manual |
| **Container / Stream / Muxing** | Kotak file / saluran data / menggabung streams | MP4 = kotak isi video+audio+subtitle |

### 8.3 AI & Machine Learning

| Istilah | Definisi | Analogi |
|---------|----------|---------|
| **LLM** | AI yang paham & generate teks (GPT, Claude) | Penulis super-cepat yang baca jutaan buku |
| **Prompt / Prompt Engineering** | Instruksi ke AI / seni membuatnya efektif | Perintah ke asisten / cara bertanya yang benar |
| **Token / Context Window** | Unit teks (~0.75 kata) / batas token sekaligus | Potongan kata / daya ingat AI |
| **Structured Output** | Memaksa AI menjawab sesuai skema JSON | Formulir isian yang wajib diikuti |
| **Zod** | Library validasi skema di TypeScript | "Satpam" yang cek output AI valid atau tidak |
| **Map-Reduce (transcript)** | Pecah transcript jadi bagian, analisa tiap bagian, gabung hasil | Bagi tugas ke tim lalu rangkum |
| **BYOK** | User pakai API key sendiri, bayar sendiri | Bawa bahan masak sendiri ke restoran |
| **Temperature / Hallucination** | Kreativitas AI / AI mengarang fakta | Keberanian nebak / AI "bohong" |
| **Ollama** | Tool menjalankan LLM lokal di PC | "Instalasi AI" di komputer sendiri |
| **GGML / Quantization** | Format model whisper.cpp / kompres model | "PDF" model AI / kompres foto |

### 8.4 Desktop App Development

| Istilah | Definisi | Analogi |
|---------|----------|---------|
| **Electron** | Framework desktop app pakai web tech | Bungkus website jadi aplikasi desktop |
| **Main / Renderer Process** | Process Node.js (OS/filesystem) / process UI (Chromium) | "Otak" / "wajah" aplikasi |
| **IPC** | Cara main & renderer berbicara | Telepon internal |
| **MessagePort** | Saluran 2-arah khusus untuk satu job (progress streaming) | Jalur telepon privat per pekerjaan |
| **utilityProcess** | Process anak Electron untuk kerja berat/native | "Ruang kerja terpisah" agar UI tak ikut crash |
| **Preload Script** | Jembatan aman antara main & renderer | Jembatan yang diawasi satpam |
| **Sidecar** | Binary eksternal yang dipanggil app (FFmpeg, whisper-cli) | Asisten eksternal yang dipanggil |
| **safeStorage** | API Electron untuk enkripsi rahasia via OS keychain | Brankas bawaan sistem |
| **Code Signing / Notarization** | Tanda tangan digital / verifikasi Apple agar app bisa dibuka di Mac | KTP digital + stempel resmi Apple |
| **asarUnpack / extraResources** | Mengeluarkan binary dari arsip agar bisa dijalankan | Mengeluarkan alat dari kardus tersegel |
| **Hardened Runtime** | Mode keamanan macOS wajib untuk notarization | Mode "gembok ekstra" |

### 8.5 Social Media & Content

| Istilah | Definisi |
|---------|----------|
| **Short-form Content** | Video pendek (15–90 detik) untuk TikTok/Reels/Shorts |
| **Hook** | Opening penarik perhatian dalam 3 detik pertama |
| **CTA** | Ajakan bertindak (subscribe, comment) |
| **Lower Third** | Grafis bawah layar (nama, judul) |
| **Karaoke Caption** | Subtitle menyala per kata sesuai waktu |
| **Retention / Engagement Rate** | Lama tonton sebelum skip / persentase interaksi |

---

## 9. Architecture & Data Flow

### 9.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ELECTRON APP (Renderer Process)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────┐  │
│  │   React UI   │  │   Timeline   │  │   Preview    │  │ Settings│  │
│  │  (Dashboard) │  │ (trim, MVP)  │  │ <video>      │  │  Panel  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────┬────┘  │
└─────────┼─────────────────┼─────────────────┼───────────────┼───────┘
          └─────────────────┴───────┬─────────┴───────────────┘
            invoke() control plane   │   MessagePort per job (progress)
┌─────────────────────────────────── ┼ ───────────────────────────────┐
│              ELECTRON MAIN PROCESS (Node.js)                         │
│  ┌──────────────┐  ┌────────┴───────┐  ┌──────────────────────┐      │
│  │  File I/O    │  │  Job Router    │  │   AI Client          │      │
│  │  + safeStore │  │  + task        │  │   (Zod, repair,      │      │
│  │  (keychain)  │  │    registry    │  │    map-reduce)       │      │
│  └──────┬───────┘  └────────┬───────┘  └──────────┬───────────┘      │
└─────────┼───────────────────┼─────────────────────┼─────────────────┘
          │            spawns  │ (utilityProcess: Sidecar Manager)      │ (BYOK, text only)
          ▼                    ▼                                        ▼
┌─────────────┐ ┌──────────────────────┐ ┌──────────┐ ┌───────────────────────┐
│  Local FS   │ │ FFmpeg / ffprobe     │ │ whisper- │ │ OpenAI / Claude /     │
│ (Videos,    │ │ (extract, cut,       │ │ cli      │ │ Gemini / Ollama       │
│  models,    │ │  reframe, burn ASS)  │ │ (Metal)  │ │ (transcript text only)│
│  .ocproj)   │ │                      │ │          │ │                       │
└─────────────┘ └──────────────────────┘ └──────────┘ └───────────────────────┘
```

### 9.2 Data Flow: Video Import → Clips Export

```
[Drop video] → [Validate via ffprobe] → [FFmpeg: extract 16kHz WAV]
   → [Sidecar: whisper-cli transcribe (stream progress over MessagePort)]
   → [Main: build segment-level transcript] → [Renderer: transcript sidebar]
   → [User: "Generate Clips"] → [Main: chunk + map-reduce prompt]
   → [AI Client: BYOK provider, structured output + Zod repair]
   → [Renderer: clip cards w/ scores] → [User: select clips + style]
   → [Sidecar: FFmpeg per clip] ── cut ── reframe 9:16 ── generate .ass ── burn captions
   → [Local FS: export to user-chosen folder] → [Renderer: summary + open folder]
```

### 9.3 Project Data Model

```typescript
interface Project {
  id: string;                    // UUID
  name: string;
  createdAt: number; updatedAt: number;
  sourceVideo: {
    path: string;
    duration: number;            // seconds
    resolution: { width: number; height: number };
    fps: number;
    format: string;
  };
  transcript: {
    language: string;
    segments: TranscriptSegment[];
    words: WordTimestamp[];      // kept LOCAL (captions); not sent to LLM
    speakers?: Speaker[];        // v0.4
  };
  clips: Clip[];
  settings: {
    targetPlatform: "tiktok" | "youtube" | "instagram" | "all";
    aspectRatio: "9:16" | "1:1" | "4:5" | "16:9";
    clipStyle: "all" | "funny" | "educational" | "controversial" | "emotional" | "motivational" | "storytelling";
    maxClips: number;
    minDuration: number;         // default 15
    maxDuration: number;         // default 90
  };
  brandTemplate?: BrandTemplate; // v0.5 (typed now, unused in MVP)
  exportHistory: ExportRecord[];
}

interface TranscriptSegment { id: string; start: number; end: number; text: string; speakerId?: string; confidence: number; }
interface WordTimestamp { word: string; start: number; end: number; confidence: number; }

interface Clip {
  id: string;
  startTime: number; endTime: number;
  title: string; hook: string;
  viralityScore: number;         // 1-10
  clipType: string; keywords: string[];
  status: "suggested" | "approved" | "edited" | "exported";
  editedStart?: number; editedEnd?: number;  // timeline trim
  captions?: Caption[]; thumbnailPath?: string;
}

interface CaptionStyle {
  fontFamily: string; fontSize: number; fontColor: string; backgroundColor: string;
  position: "top" | "middle" | "bottom";
  animation: "none" | "pop" | "fade" | "typewriter";
  highlightCurrentWord: boolean; emojiEnabled: boolean;
}
// Caption, BrandTemplate, Speaker, ExportRecord: as in v1, unchanged.
```

---

## 10. API Specifications

### 10.1 Internal IPC — Control Plane (Renderer ↔ Main, request/response)

```typescript
enum IPCChannels {
  IMPORT_VIDEO = "video:import",
  IMPORT_FROM_URL = "video:import:url",
  AUDIO_EXTRACT = "audio:extract",
  GENERATE_CLIPS = "ai:generate-clips",
  GENERATE_TITLES = "ai:generate-titles",
  ENHANCE_CAPTIONS = "ai:enhance-captions",
  EXPORT_CLIP = "video:export",
  // Project
  SAVE_PROJECT = "project:save", LOAD_PROJECT = "project:load",
  LIST_PROJECTS = "project:list", DELETE_PROJECT = "project:delete",
  // Settings (key value never returned to renderer)
  GET_SETTINGS = "settings:get", SET_SETTINGS = "settings:set",
  GET_API_KEY_STATUS = "settings:api-key-status", SET_API_KEY = "settings:set-api-key",
  // Models
  MODEL_STATUS = "model:status", MODEL_DOWNLOAD = "model:download",
  // Long jobs (start returns { jobId, MessagePort }; cancel by id)
  JOB_START = "job:start", JOB_CANCEL = "job:cancel",
  // System
  OPEN_FOLDER = "system:open-folder", SHOW_SAVE_DIALOG = "system:save-dialog",
  CHECK_UPDATE = "system:check-update",
}
```

### 10.2 Internal IPC — Streaming Jobs (MessagePort)

```typescript
// shared/jobs.ts — one discriminated union streamed over a per-job MessagePort
type JobKind = "transcribe" | "export" | "model-download";

type JobEvent<R = unknown> =
  | { t: "progress"; pct: number; stage: string; etaMs?: number }
  | { t: "partial"; data: unknown }                 // e.g. streamed transcript segments
  | { t: "done"; result: R }
  | { t: "error"; code: JobErrorCode; message: string; retriable: boolean };

type JobErrorCode =
  | "CANCELLED" | "SIDECAR_CRASH" | "INPUT_INVALID"
  | "OUT_OF_MEMORY" | "API_AUTH" | "API_RATE_LIMIT" | "TIMEOUT";

interface JobsAPI {
  start<K extends JobKind>(kind: K, params: JobParams[K]): Promise<{ jobId: string; port: MessagePort }>;
  cancel(jobId: string): Promise<void>;
}
// Cancellation is cooperative: main aborts + kills the sidecar, then emits {t:"error",code:"CANCELLED"}.
// Every job ALWAYS terminates with a done|error event — never a silent hang.
```

### 10.3 External AI API (BYOK) — structured output

```typescript
// One Zod schema is the source of truth; adapted per provider.

// OpenAI — strict json_schema (NOT the legacy json_object)
body: {
  model, messages: [{role:"system",content:SYSTEM},{role:"user",content:userPrompt}],
  response_format: { type: "json_schema", json_schema: { name:"clips", strict:true, schema } }
}

// Anthropic — SDK structured output
const { parsed_output } = await client.messages.parse({
  model, max_tokens: 4000, system: SYSTEM,
  messages: [{ role: "user", content: userPrompt }],
  output_config: { format: zodOutputFormat(ClipSchema) }
});

// Ollama — grammar-constrained JSON (full schema, not just "json")
body: { model, prompt: `${SYSTEM}\n\n${userPrompt}`, stream:false, format: jsonSchema }
```

---

## 11. UI/UX Requirements

### 11.1 Main Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  OpenClip Desktop                                    [🔍][⚙️][👤] │
├──────────┬──────────────────────────────────────┬─────────────────┤
│  PROJECT │         PREVIEW PLAYER (<video>)      │   CLIP SIDEBAR  │
│  PANEL   │    ┌──────────────────────┐           │  ┌────────────┐ │
│  [List]  │    │   Video Preview      │           │  │ Clip #1    │ │
│  [+] New │    │   (with captions)    │           │  │ ⭐ 9/10 …  │ │
│          │    └──────────────────────┘           │  │ 0:45-1:18  │ │
│          │    ┌──────────────────────────────┐   │  └────────────┘ │
│          │    │  TIMELINE (trim handles, MVP)│   │  ┌────────────┐ │
│          │    │  |====[========]====|        │   │  │ Clip #2 …  │ │
│          │    └──────────────────────────────┘   │  └────────────┘ │
├──────────┴──────────────────────────────────────┴─────────────────┤
│  [Import Video]  [Auto Generate Clips]  [Export All]  [Settings]   │
└────────────────────────────────────────────────────────────────────┘
```

### 11.2 Key Screens
Dashboard (recent projects, import), Import (drag-drop + URL + progress), Transcript (searchable + timestamps), Clip Suggestions (cards + scores + approve/reject), Timeline (trim, MVP), Export (quality/format + batch later), Settings (API keys, model, language, hotkeys, storage), **Model Download dialog** (first-run).

### 11.3 Keyboard Shortcuts (MVP subset; full set v0.6)
`Space` play/pause · `I` mark in · `O` mark out · `Cmd+E` export selected · `Cmd+N/O/S` new/open/save project · `Delete` delete clip · `+/-` zoom.

---

## 12. Non-Functional Requirements

### 12.1 Performance
| Metric | Target | Notes |
|--------|--------|-------|
| App Launch | < 3 s | electron-vite optimized |
| Audio Extraction | ~1x duration | FFmpeg native |
| Transcription (Metal, base/turbo) | 0.1x–0.4x duration | whisper.cpp on Apple Silicon |
| AI Analysis | < 15 s typical | API latency + map-reduce rounds |
| Clip Export (re-encode) | 0.5x–2x duration | videotoolbox vs libx264 |
| Timeline scrub | smooth | HTML5 `<video>` |

### 12.2 Security
- [ ] API keys via Electron **`safeStorage`** (OS keychain); **never sent to renderer**
- [ ] No video/audio to cloud — only transcript text
- [ ] Sandboxed renderer; `contextIsolation`; no `nodeIntegration`
- [ ] CSP enabled; no `eval`/inline scripts
- [ ] Code signing + notarization for all releases; updater verifies signature
- [ ] All bundled binaries signed (else notarization fails)

### 12.3 Privacy
- [ ] All video processing local by default
- [ ] Project + transcript stored locally (`.ocproj` JSON; SQLite if needed later)
- [ ] No telemetry without explicit opt-in
- [ ] BYOK — user controls their AI data; clear privacy policy

### 12.4 Compatibility
| Platform | Minimum | Status |
|----------|---------|--------|
| **macOS** | 12 (Monterey), **Apple Silicon** | **MVP target** |
| macOS Intel | 12+ | v0.2 (CPU/no-Metal path) |
| Windows | 10 (1903+) 64-bit | v0.2 |
| Linux | Ubuntu 22.04+ (AppImage/deb) | v0.2 |

### 12.5 Resource Usage
| Resource | Target | Notes |
|----------|--------|-------|
| RAM idle | < 500 MB | Electron + React |
| RAM processing | < 4 GB peak | FFmpeg + whisper |
| Install size | < 250 MB | Binaries bundled, models downloaded on demand |
| GPU | Optional but recommended | Metal accelerates whisper + export |

---

## 13. Binary Distribution & Model Download (NEW)

**Bundled binaries** (`extraResources`, signed, per-arch):
```
resources/
├── ffmpeg/darwin-arm64/   ffmpeg, ffprobe
└── whisper/darwin-arm64/  whisper-cli, default.metallib
```
Resolved at runtime by `utils/paths.ts`: **dev** → `node_modules` (`ffmpeg-static`, `ffmpeg-ffprobe-static`) / locally-built whisper; **prod** → `path.join(process.resourcesPath, ...)`. `electron-builder.yml`: `extraResources` + `asarUnpack: ['resources/**', '**/*.node']`.

**Models are NOT bundled** (75 MB – 2.9 GB). `model-manager.ts`:
1. On first transcribe, check `userData/models/ggml-<size>.bin`.
2. If absent → `ModelDownloadDialog` (default **base**; offer tiny→large-v3/turbo with size + speed/accuracy table).
3. Stream from HuggingFace (`ggml-org/whisper.cpp`), **SHA-verify**, emit `model:progress`, support resume/cancel.

This keeps the installer < 250 MB and lets users pick their speed/quality/disk trade-off.

---

## 14. GPU Detection & Fallback (NEW)

| Platform | Whisper accel | Export accel | Fallback |
|----------|---------------|--------------|----------|
| macOS Apple Silicon | Metal + Core ML | `h264_videotoolbox` | CPU `libx264` |
| macOS Intel | CPU (or Metal if available) | `videotoolbox`/`libx264` | CPU |
| Windows NVIDIA (v0.2) | CUDA | `h264_nvenc` | CPU |
| Windows/Linux other (v0.2) | Vulkan / CPU | `libx264` | CPU |

App probes capabilities at startup; Settings shows the active backend and lets the user force CPU. All flows have a CPU fallback so the app **always works**, just slower.

---

## 15. macOS Code Signing & Notarization (NEW)

- `hardenedRuntime: true`; `build/entitlements.mac.plist` includes `com.apple.security.cs.allow-jit` (Chromium) and, only if the `smart-whisper` addon path is used, `com.apple.security.cs.disable-library-validation`.
- **All unpacked binaries** (ffmpeg, ffprobe, whisper-cli) must be signed with the Developer ID or notarization fails ("invalid signature / Info.plist").
- `afterSign` hook (`build/notarize.cjs`) runs `@electron/notarize` with an App Store Connect API key.
- Requires Apple Developer Program membership ($99/yr). Document the full signing setup in `CONTRIBUTING.md`.

---

## 16. BYOK Cost & Token Budgeting (NEW)

**Send less:** the LLM gets **segment-level** text + segment start/end only. Word-level data stays local for caption rendering — ~10× fewer tokens.

**Chunk + map-reduce** for long videos:
1. Window segments into ~8–12k-token chunks with ~10 s overlap.
2. **Map:** ask each chunk for candidate clips (timestamps absolute, since real segment times are passed).
3. **Reduce:** collect candidates, **dedupe overlapping spans**, final ranking pass → top `maxClips`.

**Validation/repair ladder** (provider-agnostic, in code):
1. Provider structured-output mode → 2. `zod.safeParse` → 3. on failure, **one** repair round-trip echoing the Zod errors → 4. tolerant extraction (strip ```json fences, grab outermost `{...}`) → 5. surface `{t:"error",code:"INPUT_INVALID",retriable:true}`. Then clamp in code regardless of model: `end>start`, clamp to `[0,duration]`, drop overlaps, enforce min/max length.

**Cost estimator (UI):** before sending, show estimated input tokens × the selected model's known price (a small static price table, user-editable) so users aren't surprised. Cache results by `(transcriptHash, promptVersion, model, style)` to avoid paying twice for re-runs.

---

## 17. Job Queue, Cancellation & Temp-File Lifecycle (NEW)

**Sidecar host:** a single Electron `utilityProcess` owns all FFmpeg/whisper children — a native crash there can't take down the UI; `app`'s `child-process-gone` reports it by name.

**Orphan prevention (macOS):** track every PID; on `before-quit`/`will-quit`/`SIGINT`/`SIGTERM`/`child-process-gone`/port-close → `SIGTERM`, then `SIGKILL` after a 3 s grace. A renderer crash (port closes) is treated as implicit cancel.

**Concurrency (p-queue):** 1 transcription at a time (RAM/CPU heavy); `min(2, ceil(cores/4))` exports, serialized per output file; queue position surfaced as progress stage `"queued"`.

**Temp files:** root `app.getPath('temp')/openclip/<projectId>/<jobId>/`. Names: `audio.16k.wav`, `clip-<id>.cut.mp4`, `clip-<id>.captions.ass`, `thumb-<id>.jpg`. The extracted WAV is **cached** content-addressed (source mtime+size) under `<projectId>/cache/` for re-runs. Each `<jobId>/` scratch dir is deleted in a `finally` on success or failure. On launch, a **sweeper** removes any `temp/openclip/*/` dir not in the active-jobs set (none after a crash → all reclaimed). Final exports always go to a user-chosen folder — never temp, never in-place over the source.

---

## 18. Testing Strategy (NEW)

- **Fixtures:** generate tiny deterministic media in test setup via FFmpeg synthetic sources (`testsrc2`, `sine`, 3–5 s, fixed fps/GOP `-g 12`). Commit a couple of small `.mp4`/`.wav`. No large binaries / model weights in git or CI.
- **Vitest (bulk):** ASS `\k` cue generation (assert exact strings from word arrays), chunk/map-reduce boundaries, Zod validation + repair ladder (malformed-JSON fixtures), clip clamp/overlap, temp-path lifecycle. **Mock the LLM** at the `ai-client` boundary; **mock `safeStorage`**.
- **FFmpeg structural assertions (no pixel diff):** run the real binary on a fixture, `ffprobe` the output, assert duration within ±1 frame of the requested cut, resolution = 1080×1920, codec, captions burned (frame count), first-frame PTS for cut accuracy.
- **Playwright (thin E2E):** launch → import → transcribe (stubbed sidecar emitting a fixed transcript over the port) → generate clips (mocked provider) → export produces a non-empty file; assert streamed progress events.
- **Sidecar/port harness:** a fake `utilityProcess` entry emitting scripted `progress/partial/done/error` so cancellation, mid-job `SIGKILL`, and queueing are testable without real binaries.

---

## 19. Milestones & Roadmap (RE-SCOPED, honest estimates for a small team)

### MVP + Minimal Timeline (≈ 10–12 weeks)
Phases build hardest-unknowns-first; each ends in a runnable demo.
- **P0 Skeleton** — electron-vite + Tailwind/shadcn + Zustand + typed IPC bridge.
- **P1 Vertical slice** — import → FFmpeg audio → whisper-cli transcribe (Metal) + model-download UX + sidecar host + MessagePort jobs. *(De-risks binary bundling + Metal.)*
- **P2 AI clip detection** — 3 providers, Zod + repair + map-reduce, safeStorage keys, clip cards.
- **P3 Cut + 9:16 center-crop + export** — frame-accurate re-encode, export job, open folder.
- **P4 Karaoke captions** — `.ass` generation + libass burn.
- **P5 Project save/load** — `.ocproj`, autosave, dashboard.
- **P6 Minimal timeline** — `<video>` preview + trim handles honoring `editedStart/End`.
- **P7 Package/sign/notarize** — arm64 dmg gate.

### v0.2 — Cross-platform (Win/Linux; CUDA/Vulkan/NVENC; CI matrix)
### v0.3 — Smart reframe (ONNX face/subject tracking, smoothing, manual override)
### v0.4 — Speaker diarization (sherpa-onnx) + per-speaker caption colors
### v0.5 — Brand templates + batch export
### v0.6 — Full timeline (multi-track, split, waveform, undo/redo) + scene detection + audio enhancement
### v1.0 — Title/hook generator, auto-updater, perf, docs/tutorials
### Future — Optional self-hosted server (separate repo) + team sync + manual social-publish handoff

---

## 20. Open Source Considerations

### 20.1 License
- **Code:** MIT (permissive, commercial-friendly)
- **Models/binaries:** respect each license (whisper.cpp MIT, FFmpeg LGPL/GPL build, ONNX models per source)

### 20.2 Dependencies & Attribution
| Dependency | License | Attribution |
|------------|---------|-------------|
| FFmpeg | LGPL/GPL | Include license, offer source (use LGPL build) |
| whisper.cpp | MIT | Include copyright |
| Whisper (OpenAI) models | MIT | Include copyright |
| ONNX Runtime (v0.3+) | MIT | Include copyright |
| sherpa-onnx (v0.4+) | Apache-2.0 | Include copyright |
| Electron / React / Zustand | MIT | Include copyright |
| yt-dlp | Unlicense/MIT | Include copyright + **usage warning** |

### 20.3 Contribution Guidelines
CONTRIBUTING.md, Code of Conduct, issue/PR templates, dev-setup guide (incl. signing), ESLint + Prettier.

### 20.4 yt-dlp / URL-Download Usage Warning (NEW)
Downloading from third-party platforms may violate their Terms of Service and/or copyright. The app shows a **one-time consent dialog** clarifying the feature is for content the user owns or is licensed to use; the user accepts responsibility. yt-dlp is invoked only after consent.

### 20.5 Distribution
GitHub Releases + auto-updater (v1.0); Homebrew cask (macOS); Chocolatey/Scoop (Windows, v0.2); AppImage/deb (Linux, v0.2); website with download links.

---

## 21. Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| whisper-cli Metal/bundling issues | High | Medium | **P1 surfaces it first**; smart-whisper fallback |
| FFmpeg licensing | Medium | Medium | LGPL build, offer source |
| Large model downloads / disk | Medium | High | On-demand download, size options, base default |
| Notarization/signing friction | Medium | High | Documented signing setup, CI secrets, afterSign hook |
| AI API costs surprise users | Medium | Medium | Cost estimator + Ollama local option + result caching |
| LLM returns invalid JSON | Medium | High | Structured output + Zod repair ladder |
| 2hr transcript exceeds context | Medium | High | Segment-level + chunk map-reduce |
| Orphaned sidecar processes | Medium | Medium | utilityProcess host + PID kill on quit/crash |
| Cross-platform bugs (v0.2) | Medium | High | CI matrix, CPU fallbacks |

---

## 22. Appendices

### Appendix A: FFmpeg Command Reference
```bash
# Extract audio (16kHz mono)
ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 audio.16k.wav

# Frame-accurate cut + 9:16 center-crop (export path — re-encode)
ffmpeg -ss 30 -i input.mp4 -to 60 -vf "crop=ih*9/16:ih,scale=1080:1920" \
  -c:v h264_videotoolbox -b:v 8M -c:a aac clip.mp4

# Reframe with padding (letterbox alternative)
ffmpeg -i input.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" out.mp4

# Burn karaoke captions (ASS via libass)
ffmpeg -i clip.mp4 -vf "subtitles=clip.ass" -c:v h264_videotoolbox -c:a aac out.mp4

# Overlay logo (top-right) — v0.5
ffmpeg -i clip.mp4 -i logo.png -filter_complex "[0:v][1:v]overlay=W-w-10:10" out.mp4

# Thumbnail
ffmpeg -ss 00:00:05 -i input.mp4 -vframes 1 thumb.jpg

# Probe metadata
ffprobe -v quiet -print_format json -show_format -show_streams input.mp4
```

### Appendix B: Project File Structure (native-first)
```
openclip-desktop/
├── .github/workflows/build.yml
├── build/                       # electron-builder assets
│   ├── icon.icns
│   ├── entitlements.mac.plist
│   └── notarize.cjs             # afterSign hook
├── resources/
│   ├── ffmpeg/darwin-arm64/     # ffmpeg, ffprobe (signed, unpacked)
│   └── whisper/darwin-arm64/    # whisper-cli, default.metallib
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── ipc/                 # video.ts audio.ts ai.ts project.ts settings.ts model.ts transcribe.ts
│   │   ├── services/            # ffmpeg.ts whisper.ts sidecar-manager.ts model-manager.ts
│   │   │                        # ai-client.ts ass-captions.ts project-store.ts
│   │   └── utils/               # paths.ts security.ts (safeStorage) ffprobe.ts
│   ├── preload/index.ts         # typed contextBridge -> window.openclip
│   ├── renderer/src/
│   │   ├── main.tsx App.tsx
│   │   ├── components/          # Dashboard ImportPanel TranscriptPanel ClipCard ClipSidebar
│   │   │                        # PreviewPlayer Timeline ExportPanel SettingsPanel ModelDownloadDialog + ui/
│   │   ├── stores/              # projectStore.ts uiStore.ts settingsStore.ts
│   │   ├── hooks/               # useJob.ts (MessagePort -> AsyncIterable) useProject.ts
│   │   └── types/               # ipc.ts project.ts
│   └── shared/                  # channels.ts jobs.ts schema.ts (Zod, used by both sides)
├── tests/ { unit/ e2e/ fixtures/ }
├── electron.vite.config.ts
├── electron-builder.yml
├── package.json tsconfig.json tailwind.config.ts
└── README.md
```

### Appendix C: Sidecar Invocation Examples (native, no Python)
```typescript
// services/whisper.ts (spawned inside the utilityProcess sidecar host)
import { spawn } from "node:child_process";
const child = spawn(whisperBin, [
  "-m", modelPath, "-f", wavPath,
  "--output-json", "--output-file", outBase,
  "--max-len", "1",     // word-level timestamps
  "-pp",                // progress to stderr -> parse -> JobEvent {t:"progress"}
]);
// Parse stderr for progress %, read <outBase>.json for {segments[].words[]}.

// services/ffmpeg.ts — progress parsed from stderr "out_time_ms"/frame= for export jobs.
// services/ai-client.ts — one Zod schema -> per-provider structured output + repair ladder + map-reduce (see §16).
```
> The v1.0 Python scripts (`transcribe.py`, `diarize.py`, `analyze_audio.py`) are **removed** — transcription is native (`whisper-cli`); diarization (sherpa-onnx) and analysis arrive in v0.4/v0.6 as ONNX/FFmpeg, still no bundled Python.

---

## 23. Approval & Sign-off

| Role | Name | Date | Status |
|------|------|------|--------|
| Product Owner | | | Pending |
| Tech Lead | | | Pending |
| UX Designer | | | Pending |
| QA Lead | | | Pending |

---

*Document Version: 2.0.0*
*Last Updated: 2026-05-29*
*Next Review: Upon Phase 1 (vertical slice) completion — validate whisper-cli on Metal + binary bundling before committing to the rest.*
