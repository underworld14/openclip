# Agent Instructions

See `CLAUDE.md` for project architecture, build/test commands, and conventions.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **Note remaining work** - Write down anything that needs follow-up in the hand-off
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
4. **Clean up** - Clear stashes, prune remote branches
5. **Verify** - All changes committed AND pushed
6. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- pine:begin recipe=agents profile=full version=0.1.0-dev hash=937a71905286b89e -->
This project uses Pine for issue tracking.

## Pine issue tracking

This repository uses [Pine](https://github.com/underworld14/pine) — git-native issue tracking in `.pine/` (tickets + learnings, branch-scoped, committed with your code).

### Always do

- Track work with **Pine tickets** — do **not** use markdown TODO lists for issue tracking.
- Start with `pine context`; pick work with `pine ready`.
- Planning a non-trivial change? `pine create --type feature --title "…"` first, move it to `doing`, and when done `pine close <ID> --evidence` (marks done + attaches the file-change evidence). Run `pine inject` for a compact agent prompt-injector.
- Write progress back to `.pine/tickets/<ID>.md` (or `pine update` / `pine close`). Move tickets by editing `status` (board columns: todo, doing, testing, done).
- Capture durable insights with `pine learn "…"` into `.pine/MEMORY.md` or `.pine/memory/<topic>.md` (not a new LRN file per ticket). Use `--scope ticket` only for ephemeral ticket notes.
- Preferences that apply in **every** repo (your tools, style, habits) belong in your machine-wide memory: `pine learn -g "…"` → `~/.pine/`. Project memory wins on conflict.

### Full workflow

When you need the complete Pine workflow (commands, write-back rules, learnings lifecycle), **load the pine skill**:

- Codex / Factory / Gemini / generic agents: `.agents/skills/pine/SKILL.md`
- Claude Code: `.claude/skills/pine/SKILL.md`

If no skill file is installed, use `pine context` and `pine --help`.
<!-- pine:end -->
