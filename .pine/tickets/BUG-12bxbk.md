---
id: BUG-12bxbk
title: The imported file's name is sent to the LLM as the video title — the privacy promise does not mention it
status: todo
priority: medium
labels:
    - security
parent: EPIC-k83ghw
phase: p2
created: "2026-08-15T11:28:11Z"
updated: "2026-08-15T11:28:11Z"
---

## Problem
The README's headline claim is "transcript text only". The filename also goes.

## Evidence
- The prompt's video title is populated from the imported file's name.
- `README.md` states "The only thing that is ever sent anywhere is the **transcript text** —
  segment-level text only".

## Impact
Filenames routinely carry client names, NDA project codes and dates — exactly the material
the privacy positioning promises stays local, and exactly the audience ("an NDA'd
interview, a client's raw footage") the README targets.

## Fix
Either stop sending the filename, or send a user-editable title, and correct the README and
the in-app privacy copy to state precisely what leaves the machine.

## Acceptance Criteria
- [ ] What is transmitted is either filename-free or explicitly disclosed
- [ ] README and in-app copy match the code
