# Execution Plan: Build two "lean out CLAUDE.md" skills

> Self-contained spec. A fresh Claude Code session can execute this with no prior context.
> Goal: create two reusable skills that shrink a fat `CLAUDE.md` into a lean always-loaded
> file plus detail that loads on demand ("air-traffic-control" pattern).

---

## 0. Background you need (verified facts — do not re-research)

**Why:** Long CLAUDE.md files burn context every session and dilute instruction adherence.
Anthropic's guidance is to keep CLAUDE.md **under ~200 lines** and offload detail.

**How CLAUDE.md / memory loading actually works** (from Anthropic `memory.md` docs):
- `./CLAUDE.md`, parent dirs, `~/.claude/CLAUDE.md`, `CLAUDE.local.md` → **always loaded** at launch.
- Subdirectory `CLAUDE.md` → loaded **on demand** when Claude reads files in that subdir.
- `.claude/rules/*.md` **with `paths:` frontmatter** → loaded **only when Claude reads/edits a file
  matching the glob**. This is the real context-saver for code-domain content.
- `.claude/rules/*.md` **without `paths:`** → loads at launch every session (no savings).
- `@import` / `@path/to/file` syntax → **always loads at launch**. Good for organization, **useless
  for leaning** (it does NOT reduce context). Do not use it to lean.
- Any other folder under `.claude/` (e.g. `.claude/docs/`) is **not** auto-loaded — files there are
  read only when something points Claude to them.

**Conversational pointer pattern (works in ANY runtime):** put a line in CLAUDE.md like
*"When deploying, read `.claude/docs/deploy.md` first."* The model chooses to `Read` it when the
topic comes up. This is the only on-demand mechanism for content not tied to file paths, and the
only one that works in custom SDK runtimes.

**ClaudeClaw runtime is special:** the ClaudeClaw bot injects the agent's entire CLAUDE.md as a
text blob into the first message of each new session and **ignores `.claude/rules/` and `@import`
entirely**. The agent's cwd is the project root, not the config dir. So for ClaudeClaw:
- pointers-only (no frontmatter rules),
- pointer targets must use **absolute paths**,
- changes take effect only after **restarting the service** and on a **new session**.

**Key insight for both skills:** path-scoped rules only help content tied to a set of files. Topic /
procedure / tone content has no file association → it stays inline (if always relevant) or uses a
conversational pointer. A correct lean split for a standard project uses **both** mechanisms.

---

## 1. Skill-authoring conventions (house style on this machine)

- Skills live at `~/.claude/skills/<skill-name>/SKILL.md`, optional `~/.claude/skills/<skill-name>/scripts/`.
- `SKILL.md` starts with YAML frontmatter: `name` (lowercase-hyphenated, required),
  `description` (required — drives triggering; list concrete trigger phrases), optional
  `user_invocable: true`.
- Invoke a bundled script by absolute path, e.g. `python3 ~/.claude/skills/lean-claude-md/scripts/leanmd.py ...`.
- Use the `AskUserQuestion` tool for confirmations/choices. Never proceed silently on a destructive step.
- Reference the user's argument as `$ARGUMENTS`.

---

## 2. Files to create

```
~/.claude/skills/lean-claude-md/SKILL.md
~/.claude/skills/lean-claude-md/scripts/leanmd.py
~/.claude/skills/lean-claudeclaw-md/SKILL.md
~/.claude/skills/lean-claudeclaw-md/scripts/leanmd.py      # identical copy of the script
```

Create the directories first (`mkdir -p`). Write the four files with the exact contents in §3–§5.

---

## 3. `leanmd.py` (identical in both skills' `scripts/` dirs)

Deterministic safety helper. Categorization stays the model's job; this only does inventory and a
content-preservation gate. Copy verbatim into BOTH `scripts/` directories.

```python
#!/usr/bin/env python3
"""leanmd.py - helper for the lean-claude-md / lean-claudeclaw-md skills.

Deterministic safety bits only. Categorization is the model's job.

Subcommands:
  inventory <CLAUDE.md>
      Print sections (by markdown heading) with line counts and an
      offload-candidate flag (sections heavy in code blocks / command
      recipes). Prints total line count.

  verify <backup.md> <new_path> [<new_path> ...]
      Confirm every high-signal token from the backup (fenced code-block
      lines + inline `code` spans) still appears somewhere across the new
      file set. <new_path> may be a file or a directory (dirs scanned
      recursively for *.md). Exits 1 if any token is missing.
"""
import sys, os, re

def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()

def split_sections(text):
    lines = text.splitlines()
    sections, in_fence = [], False
    cur = {"title": "(preamble)", "start": 1, "lines": []}
    for i, ln in enumerate(lines, 1):
        if ln.strip().startswith("```"):
            in_fence = not in_fence
        if not in_fence and re.match(r"^#{1,3}\s+", ln):
            if cur["lines"] or cur["title"] != "(preamble)":
                sections.append(cur)
            cur = {"title": ln.strip("# ").strip(), "start": i, "lines": []}
        cur["lines"].append(ln)
    sections.append(cur)
    return sections

def code_block_lines(text):
    out, in_fence = [], False
    for ln in text.splitlines():
        if ln.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence and ln.strip():
            out.append(ln.strip())
    return out

INLINE_CODE = re.compile(r"`([^`\n]+)`")

def inline_spans(text):
    spans, in_fence = [], False
    for ln in text.splitlines():
        if ln.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for m in INLINE_CODE.findall(ln):
            s = m.strip()
            if len(s) >= 3:
                spans.append(s)
    return spans

def cmd_inventory(path):
    text = read(path)
    secs = split_sections(text)
    total = len(text.splitlines())
    print(f"FILE: {path}")
    print(f"TOTAL LINES: {total}  (Anthropic target: < ~200)\n")
    print(f"{'ln':>4}  {'lines':>5}  {'code':>4}  cand  section")
    print("-" * 64)
    for s in secs:
        body = "\n".join(s["lines"])
        nlines = len(s["lines"])
        ncode = len(code_block_lines(body))
        recipe = bool(re.search(r"```|--?\w|/\w+\.\w+|\b(cli|command|curl|node|python3|bash)\b", body, re.I))
        cand = "YES " if (ncode > 0 or (recipe and nlines > 6)) else "  - "
        print(f"{s['start']:>4}  {nlines:>5}  {ncode:>4}  {cand}  {s['title'][:40]}")
    print("\nYES = OFFLOAD candidate. Confirm with judgment (see heuristics), not blindly.")

def gather_new_text(paths):
    chunks = []
    for p in paths:
        if os.path.isdir(p):
            for root, _, files in os.walk(p):
                for fn in files:
                    if fn.endswith(".md"):
                        chunks.append(read(os.path.join(root, fn)))
        elif os.path.isfile(p):
            chunks.append(read(p))
    return "\n".join(chunks)

def cmd_verify(backup, news):
    src = read(backup)
    new = gather_new_text(news)
    tokens, seen = [], set()
    for t in code_block_lines(src) + inline_spans(src):
        if t not in seen:
            seen.add(t); tokens.append(t)
    missing = [t for t in tokens if t not in new]
    print(f"BACKUP: {backup}")
    print(f"NEW SET: {', '.join(news)}")
    print(f"high-signal tokens checked: {len(tokens)}")
    if not missing:
        print("RESULT: OK - every command/path/code token preserved.")
        return 0
    print(f"RESULT: {len(missing)} TOKEN(S) MISSING - content may have been dropped:")
    for t in missing:
        print(f"  MISSING: {t}")
    return 1

def main():
    if len(sys.argv) < 3:
        print(__doc__); return 2
    cmd = sys.argv[1]
    if cmd == "inventory":
        cmd_inventory(sys.argv[2]); return 0
    if cmd == "verify":
        return cmd_verify(sys.argv[2], sys.argv[3:])
    print(__doc__); return 2

if __name__ == "__main__":
    sys.exit(main())
```

---

## 4. `~/.claude/skills/lean-claude-md/SKILL.md`

Write this file verbatim.

````markdown
---
name: lean-claude-md
description: >
  Lean out a bloated CLAUDE.md for a standard Claude Code project by splitting it into a short
  always-loaded file plus detail that loads on demand. Keeps identity and always-on rules inline,
  moves code-domain conventions into path-scoped .claude/rules/ files (auto-load only when Claude
  touches matching files), and moves topic/procedure detail into .claude/docs/ files referenced by
  read-on-demand pointers. Use when the user says "lean out my CLAUDE.md", "my CLAUDE.md is too long",
  "shrink CLAUDE.md", "split CLAUDE.md into rules", "air-traffic-control my CLAUDE.md", or wants to
  cut CLAUDE.md context. NOT for ClaudeClaw agent CLAUDE.md files (those live under ~/.claudeclaw and
  need pointers-only) - use the lean-claudeclaw-md skill for those.
user_invocable: true
---

# lean-claude-md

Shrink a standard Claude Code project's `CLAUDE.md` using the air-traffic-control pattern:
a lean always-loaded file that routes to detail loaded on demand.

## When NOT to use
- The file is already short (< ~120 lines) and focused - say so, do nothing.
- The target lives under `~/.claudeclaw/` or is a ClaudeClaw agent prompt - use `lean-claudeclaw-md`
  instead (that runtime ignores `.claude/rules/` and needs absolute-path pointers).

## How loading works (so you categorize correctly)
- `CLAUDE.md` and `~/.claude/CLAUDE.md` always load at launch.
- `.claude/rules/X.md` WITH `paths:` frontmatter loads only when Claude reads/edits a file matching
  the glob. This is the context saver for code-domain content.
- `.claude/rules/X.md` WITHOUT `paths:` loads at launch (no savings) - do not put offloaded content
  there without a `paths:` field.
- `@import` always loads at launch - never use it to lean.
- Files anywhere else (e.g. `.claude/docs/X.md`) are read only when a pointer tells Claude to.

## Categorization heuristics (decide per section)
Decide by "needed every turn, or only when a topic/path comes up?" - never by size alone.
- INLINE (never offload): identity/personality; never-break behavioral rules (tone, formatting,
  "just execute"); always-on response style; operational unblockers kept as a 1-line stub even when
  the topic is offloaded (e.g. a PATH fix, how to find the repo root); a short "how you work"; the
  rules/pointer index.
- OFFLOAD: step-by-step cookbooks and command recipes; exhaustive option/reference lists; rarely
  triggered commands; code-domain conventions tied to specific paths.
- Split, don't drop: a section with both an always-on aspect and procedural detail keeps a 1-2 line
  nub inline and offloads the procedure.
- Mechanism per offloaded section:
  - tied to a set of files (e.g. "API rules", "test conventions", "DB migrations") -> path-scoped
    rule `.claude/rules/<name>.md` with `paths:` glob inferred from the content.
  - topic/procedure with no clear file association (deploy steps, commands, project background,
    release process) -> `.claude/docs/<name>.md` + a pointer line in the CLAUDE.md index.
  - if a glob is unclear, prefer a pointer over a wrong `paths:` scope.

## Procedure
1. Resolve target: use `$ARGUMENTS` as a path if given, else `./CLAUDE.md`. Confirm it exists and
   read it. Identify the project root (the dir holding CLAUDE.md or its `.git`).
2. Back up: copy to `CLAUDE.md.bak` (if a `.bak` exists, pick `CLAUDE.md.bak.1` etc and say so).
3. Inventory: run
   `python3 ~/.claude/skills/lean-claude-md/scripts/leanmd.py inventory <path-to-CLAUDE.md>`
   to get sections, line counts, and offload candidates.
4. Categorize every section using the heuristics above. For each offload, decide rule-vs-pointer and,
   for rules, infer the `paths:` glob from the content.
5. Present the split plan and CONFIRM. Show three lists: INLINE (with projected line count),
   RULES (`name` + glob), POINTERS (`name`). Use `AskUserQuestion` to let the user adjust the boundary
   or move items between buckets. Do not proceed on silence.
6. Write the files:
   - Lean `CLAUDE.md`: inline content + a "## Rules and references" section. Note that path-scoped
     rules auto-load (no index entry needed) but include a brief "Rules in `.claude/rules/` load when
     editing matching files" line; list each POINTER as `When <topic>, read \`.claude/docs/<name>.md\`.`
   - `.claude/rules/<name>.md`: `paths:` frontmatter + the lifted content (lift near-verbatim).
   - `.claude/docs/<name>.md`: the lifted content (no frontmatter needed).
7. Verify:
   - `python3 ~/.claude/skills/lean-claude-md/scripts/leanmd.py verify CLAUDE.md.bak CLAUDE.md .claude/rules .claude/docs`
     must report OK (no missing tokens).
   - Confirm every pointer path in CLAUDE.md resolves to a written file.
   - Confirm lean `CLAUDE.md` is under ~150 lines.
8. Report: before/after line counts, files written, verify result. Mention the user can tweak any
   `paths:` glob.

## Safety
Always back up first. Never drop content - the `verify` token gate must pass before you call it done.
If verify reports missing tokens, fix the offload (a command/path got lost) and re-run.
````

---

## 5. `~/.claude/skills/lean-claudeclaw-md/SKILL.md`

Write this file verbatim. (Its `scripts/leanmd.py` is the same script from §3.)

````markdown
---
name: lean-claudeclaw-md
description: >
  Lean out a ClaudeClaw agent's CLAUDE.md (the Telegram bot under ~/.claudeclaw). Splits it into a
  short always-loaded prompt plus detail the agent reads on demand via absolute-path pointers, because
  the ClaudeClaw runtime injects the whole CLAUDE.md as a blob and ignores .claude/rules/ and @import.
  Use when the user says "lean a claudeclaw agent prompt", "shrink the comms/ops/research agent
  CLAUDE.md", "lean my claudeclaw agents", "trim ~/.claudeclaw CLAUDE.md", or is leaning a NEW or
  client ClaudeClaw agent they created. For ordinary Claude Code project CLAUDE.md files use
  lean-claude-md instead.
user_invocable: true
---

# lean-claudeclaw-md

Shrink a ClaudeClaw agent's `CLAUDE.md` using the air-traffic-control pattern, adapted to the
ClaudeClaw runtime.

## Runtime facts (why this differs from a normal project)
- ClaudeClaw injects the agent's entire CLAUDE.md as a text blob into the first message of each new
  session. It does NOT support `.claude/rules/`, `paths:` frontmatter, or `@import`.
- The only on-demand mechanism is the agent choosing to `Read` a file you point it to.
- The agent's cwd is the project root, NOT the config dir - so pointers MUST use absolute paths.
- Changes take effect only after the bot restarts AND on a new session (resumed sessions keep old
  context). Remind the user to restart the relevant service.

## Layout
- Main agent: `~/.claudeclaw/CLAUDE.md`, with rule files in `~/.claudeclaw/rules/`.
- Sub-agents: `~/.claudeclaw/agents/<id>/CLAUDE.md` (ids e.g. comms, content, ops, research, vault,
  _template). Put their rule files in `~/.claudeclaw/agents/<id>/rules/`.

## Categorization heuristics (decide per section)
Decide by "needed every turn, or only when a topic comes up?" - never by size alone.
- INLINE (never offload): identity/personality; never-break behavioral rules (e.g. no em dashes,
  no AI cliches, just execute); always-on response/message style; operational unblockers kept as a
  1-line stub even when the topic is offloaded (e.g. a `gws` PATH fix); a short "how you work"; the
  rules index.
- OFFLOAD to a pointer: step-by-step cookbooks (scheduling, mission delegation, file-send markers,
  gws recipes); exhaustive reference; rarely triggered special commands; security/lock details.
- Split, don't drop: keep a 1-2 line always-on nub inline (e.g. "keep replies tight, plain text,
  voice = execute") and offload the procedural detail.

## Procedure
1. Resolve target(s) from `$ARGUMENTS`:
   - an agent id (e.g. `comms`) -> `~/.claudeclaw/agents/comms/CLAUDE.md`
   - a path -> that file
   - `all` -> every `~/.claudeclaw/agents/<id>/CLAUDE.md` plus `~/.claudeclaw/CLAUDE.md` (loop the
     whole procedure per file)
   - nothing -> default to `~/.claudeclaw/CLAUDE.md`
2. Back up each target to `CLAUDE.md.bak` (suffix `.1`, `.2` if one exists; say so).
3. Inventory: `python3 ~/.claude/skills/lean-claudeclaw-md/scripts/leanmd.py inventory <path>`.
4. Categorize sections with the heuristics. Everything offloaded becomes a sibling-`rules/` file +
   an absolute-path pointer (no frontmatter, no `paths:`).
5. Present the split plan (INLINE with projected line count; OFFLOAD list -> target rule files) and
   CONFIRM via `AskUserQuestion`. Do not proceed on silence.
6. Write:
   - Lean `CLAUDE.md`: inline content + a "## Rules index (read on demand)" table mapping each topic
     to its ABSOLUTE rule-file path, with a line like "When the topic comes up, read the matching file
     before acting."
   - Rule files in the sibling `rules/` dir (lift content near-verbatim).
7. Verify:
   - `python3 ~/.claude/skills/lean-claudeclaw-md/scripts/leanmd.py verify <CLAUDE.md.bak> <CLAUDE.md> <rules-dir>`
     must report OK.
   - Confirm every absolute pointer path resolves.
   - Confirm lean `CLAUDE.md` is well under ~150 lines.
8. Report before/after line counts + files written + verify result, and tell the user:
   "Restart the relevant claudeclaw service for this to take effect; it loads on the next new session."

## Safety
Back up first, never drop content (verify gate must pass), confirm the boundary before writing.
````

---

## 6. Verification (run after creating the four files)

1. **Script sanity** (uses the existing already-leaned main file as a fixture if present):
   - `python3 ~/.claude/skills/lean-claude-md/scripts/leanmd.py inventory ~/.claudeclaw/CLAUDE.md`
     should print sections + a total line count and flag recipe-heavy sections `YES`.
   - If `~/.claudeclaw/CLAUDE.md.bak` exists, run
     `python3 ~/.claude/skills/lean-claude-md/scripts/leanmd.py verify ~/.claudeclaw/CLAUDE.md.bak ~/.claudeclaw/CLAUDE.md ~/.claudeclaw/rules`
     and confirm `RESULT: OK`.
2. **lean-claude-md dry run:** copy a fat CLAUDE.md (e.g. this repo's
   `/home/chaka/projects/claudeclaw-os/CLAUDE.md`) into a scratch dir, run the skill there in
   propose-then-confirm mode, and confirm: lean `CLAUDE.md` < ~150 lines; `.claude/rules/*.md` carry
   valid `paths:` frontmatter (parse one as YAML); `.claude/docs/*.md` pointer targets exist and are
   referenced from the index; `CLAUDE.md.bak` exists; `verify` reports OK.
3. **lean-claudeclaw-md dry run:** copy `~/.claudeclaw/agents/_template/CLAUDE.md` (or any agent file)
   into a scratch dir, run the skill, and confirm pointers use absolute paths, a sibling `rules/` dir
   was written, backup exists, `verify` reports OK.
4. **Trigger check:** confirm both skills appear in the skill list with their descriptions and that
   "lean out my CLAUDE.md" routes to `lean-claude-md` while a ClaudeClaw-agent phrasing routes to
   `lean-claudeclaw-md`.

## 7. Out of scope
- Actually leaning the live ClaudeClaw agent files (run `lean-claudeclaw-md all` afterward).
- Any unrelated CLAUDE.md double-loading cleanup.

## 8. Reference: a known-good lean result to mirror
`~/.claudeclaw/CLAUDE.md` was previously leaned 201 -> 95 lines: identity + never-break rules +
About-the-user + how-you-work + tool/skill list + a `gws` stub (with the PATH-fix line kept inline) +
a 2-line message-format nub + memory + a "Rules index" table pointing (absolute paths) to
`~/.claudeclaw/rules/{scheduling,missions,sending-files,gws,message-format,special-commands,security}.md`.
That is the target shape for the ClaudeClaw skill's output.
