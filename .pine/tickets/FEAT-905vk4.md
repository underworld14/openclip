---
id: FEAT-905vk4
title: Project management is read-only and load failures are swallowed; internal spec jargon leaks into user copy
status: todo
priority: medium
labels:
    - ux
    - projects
parent: EPIC-f953vk
created: "2026-08-08T15:56:46Z"
updated: "2026-08-08T15:56:46Z"
---

## Current behavior

Dashboard.tsx:30-48 and Welcome.tsx:46-53 render an open-only button per project — no rename, no delete, no duplicate, no reveal-in-Finder, no context menu. Both call `void open(row.id)`, so a rejected load produces no spinner, no toast, and no error (the promise result is discarded). `projectActions.remove` exists at useProject.ts:169-173 with zero callers. Meanwhile ModelDownloadDialog.tsx:88 tells users 'Models are downloaded on demand (PRD §13)', and App.tsx:158-165's header button reads 'Export All' while the panel it opens has 'Export clip' as its primary action (ExportPanel.tsx:456). The import dialog (App.tsx:185-192) also never closes itself on success.

## Desired behavior

A project row context menu with Rename / Duplicate / Reveal in Finder / Delete (confirmed), a loading state and a toast on load failure, and a project name visible and editable in the title bar. Replace internal citations with plain language; rename the header button to 'Export…'; auto-close the import dialog when the pipeline reports done.

## Competitor precedent

LokaClip ships a Projects screen separating drafts from rendered work with one-click reopen and storage management. YT-Short-Clipper's Session Browser lists the last 50 sessions with status badges and a resume entry point.

## Implementation sketch

Wire the existing `projectActions.remove` (useProject.ts:169-173) plus new `rename`/`duplicate` into Dashboard.tsx rows using the already-bundled-but-unused `components/ui/dropdown-menu.tsx` (226 lines, zero importers). Change `void open(row.id)` at Welcome.tsx:51 and Dashboard.tsx:36 to `open(row.id).catch(e => toast.error('Could not open project', {description: String(e)}))`. Copy fixes are one-liners: ModelDownloadDialog.tsx:88, App.tsx:164. For auto-close, have App.tsx subscribe to the import controller's `stage === 'done'` and `setModal('none')`.

## Sizing

Impact: **medium** · Effort: **medium**

## Provenance

Found by a multi-agent sweep of the codebase cross-referenced against OpusClip, Kapwing AI Clip Maker, LokaClip, yt-short-clipper and SupoClip. Every `file:line` above was read directly from the source tree.
