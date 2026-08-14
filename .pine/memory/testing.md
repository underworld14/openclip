---
topic: testing
updated: 2026-08-14T14:40:35Z
---

# testing

- 2026-08-14: clipFixture ships editedStart/editedEnd AND thumbnailPath. A test that spreads it without clearing them gets resolveBounds at 13-40s and a thumbnail it did not ask for — which makes absent-case assertions pass for the wrong reason. Clear them explicitly.
- 2026-08-14: Radix restores focus to the menu trigger when a DropdownMenu closes. If the selected item mounts an autoFocus input with an onBlur commit, that focus restore blurs it and the edit cancels itself before a key is typed. onCloseAutoFocus+preventDefault does NOT stop it; treat the FIRST blur as the menu closing and take focus back.
