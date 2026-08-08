---
id: FEAT-hmsg5h
title: Drag-and-drop is advertised in the UI copy but no drop target exists anywhere
status: doing
priority: high
labels:
    - ux
    - import
parent: EPIC-xzzpty
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T17:13:27Z"
---

## Current behavior

Welcome.tsx:32 tells the user 'Turn a long video into viral shorts — drop a file or paste a YouTube link', and ImportPanel's own docstring claims 'file picker + drop'. `grep -rniE "onDrop|onDragOver|dataTransfer" src/renderer/src/` returns zero matches. This is also the first acceptance criterion of PRD §6.1. The text field's placeholder (ImportPanel.tsx:58) says URL only; the only hint that a file path works is the aria-label (:57).

## Desired behavior

A real drop zone on the Welcome card and the editor canvas: dashed border + 'Drop a video here' on dragenter, ffprobe validation on drop, and a soft warning for unsupported types or very short sources. Fix the placeholder to 'Paste a YouTube URL or drop a video file…'.

## Competitor precedent

OpusClip's landing input is 'Drop a video link' beside an 'Upload files' affordance. Kapwing accepts upload-or-link in one combined field and states accepted formats inline. LokaClip markets drag-a-local-file as its headline differentiator ('Hampir semua AI clipper memaksamu menempelkan link').

## Implementation sketch

Add `onDragOver`/`onDragLeave`/`onDrop` to the wrapper in ImportPanel.tsx (and a full-window overlay in App.tsx). In the drop handler read `e.dataTransfer.files[0].path` (available under Electron), feed it to the controller's existing `importFile(path)` — the file path branch already exists, so this is purely a new entry point. Note `sandbox: true` still exposes `File.path` in Electron; if not, use `webUtils.getPathForFile` exposed through a new preload helper. Also update the placeholder at ImportPanel.tsx:58.

## Sizing

Impact: **high** · Effort: **small**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
