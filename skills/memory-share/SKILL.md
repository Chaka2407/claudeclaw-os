---
name: memory-share
description: Review per-agent memories and selectively promote genuinely universal facts to the shared tier (visible to all agents). Use for "/memory-share", "memory share", "review memories for sharing", "promote a memory to shared", "mark memory shared", "which memories should be shared", or the one-time shared-tier migration for an install that already runs multiple agents. Conservative by design — proposes, never auto-shares.
user_invocable: true
---

# Memory Share

Promote the small set of genuinely system-wide memories to the **shared tier** so every
agent recalls them, without re-opening the cross-agent leak that per-agent scoping closed.

## Background (why this exists)

Memory recall is scoped to `WHERE chat_id = ? AND (agent_id = ? OR shared = 1)`. The
`shared` column defaults to `0`, and the per-agent isolation was made **non-retroactive**
on purpose: existing rows stay private so one agent's disposition never leaks into another.
The original incident was a non-builder agent (Naomi) absorbing the hub agent's code-fix
memories and starting to self-fix code.

So the shared tier is a **narrow, deliberate exception**, not a synonym for "important."
This skill is the human-in-the-loop gate that promotes only the right memories.

## When to use

- **Gap-closer (one-time):** an install already runs multiple agents → review every agent's
  existing high-value memories once and promote the universal ones.
- **Recurring:** run periodically (e.g. on the memory-hygiene cadence) to catch new
  universal facts that were saved private.

Single-agent installs do not need this — scope already matches everything that agent owns.

## The marker file (forward-only after the first run)

Promoted (`shared = 1`) and superseded rows drop out of the pool automatically. The rows you
**deliberately keep private** do not — without a marker they would resurface every run and
force a full re-triage. The marker fixes that.

State lives at `<repo-root>/store/memory-share-state.json`:

```json
{ "last_reviewed_id": 562, "last_run_at": 1749271234, "promoted_total": 15 }
```

`last_reviewed_id` is a **high-water mark on `memories.id`**. Memory ids are
`AUTOINCREMENT`, so every new memory always sorts above the cutoff — monotonic, with none of
the clock-skew risk a timestamp carries (this install goes offline; do not gate on time).

- **No marker file present** → gap-closer: full sweep across all ids.
- **Marker present** → recurring: only consider `id > last_reviewed_id`.

After each completed run (any approval outcome, including "share nothing"), bump
`last_reviewed_id` to the max id seen this run. If the user bails before deciding, do not bump.

## The rubric (the heart of this skill)

Apply this test to every candidate. Be strict; when in doubt, keep private.

**Promote to shared only if BOTH litmus questions pass:**
1. "Would this be equally true and useful in *every* agent's head?" → yes
2. "Is this about *one agent* — its role, persona, preferences, workflow, a point-in-time
   event, or a client/lead?" → no

**Qualifying categories** (`category` to tag each share entry):
- `system-rule` — e.g. pull the system clock / never infer dates, credentials never get
  pushed, tool-access lockdown, output-formatting constraints of the shared bot.
- `identity-roster` — the agent roster, rename history, display-name layer, username→person maps.
- `infra-path` — store/db path, project-structure conventions, deploy/`pm2 save` procedure,
  shared-runtime service facts (ports, TTS/STT).
- `external-api` — hard limits and quirks of external services (e.g. Skool 30-item cap).
- `boundary` — lane-separation rules phrased as a **prohibition** ("code/pipeline/schema
  changes are the hub agent's job; other agents stage and escalate"). These are *good* to
  broadcast because they reinforce separation rather than invite code edits.

**HARD EXCLUSION — never promote, regardless of importance or score:**
- Any **builder / code-fix disposition** (memories that read as license to edit, fix, build,
  merge, or test code). This is the exact class that caused the leak.
- Per-agent **role / persona / workflow mechanics** (what that agent does or prefers).
- **Session checkpoints** and point-in-time work logs.
- **Client / lead / prospect** notes.
- **Superseded or stale** facts, or two candidates that **conflict** (e.g. two different
  "current branch" values) — resolve to one truth first, never share a stale value.

## Steps

### 1. Locate the live database

The DB is at `<repo-root>/store/claudeclaw.db`. Use the `PROJECT_ROOT` your agent config
already defines; otherwise resolve the repo root. Confirm the file exists before touching it.

### 2. Pull the candidate pool

Default pool: not-yet-shared, not superseded, and high-value (pinned or importance ≥ 0.7).
Read the marker file first to decide the cutoff, then scope to one agent with the optional
argument or sweep all agents.

```bash
STATE="$PROJECT_ROOT/store/memory-share-state.json"
CUTOFF=$( [ -f "$STATE" ] && sed -n 's/.*"last_reviewed_id"[: ]*\([0-9]*\).*/\1/p' "$STATE" || echo 0 )

# Forward-only when a marker exists (CUTOFF>0); full sweep on first run (CUTOFF=0):
sqlite3 -json "$DB" "SELECT id, agent_id, importance AS imp, pinned AS pin, summary AS s \
  FROM memories \
  WHERE shared = 0 AND superseded_by IS NULL AND id > $CUTOFF \
    AND (pinned = 1 OR importance >= 0.7) \
  ORDER BY agent_id, importance DESC;"

# One agent (recurring):  add  AND agent_id = '<agent>'
```

**Tail catch (opt-in only).** A pre-cutoff memory can later be pinned or cross the 0.7 line
and a pure `id > cutoff` query would skip it. Do not pull these in by default. Instead, when
the user asks ("include older pinned ones", "deep sweep"), drop the `id > $CUTOFF` clause for
**pinned, still-unshared** rows only:

```bash
# Below-cutoff pinned stragglers, surfaced only on request:
sqlite3 -json "$DB" "SELECT id, agent_id, importance AS imp, pinned AS pin, summary AS s \
  FROM memories \
  WHERE shared = 0 AND superseded_by IS NULL AND pinned = 1 AND id <= $CUTOFF \
  ORDER BY agent_id, importance DESC;"
```

In recurring runs, mention in the proposal how many such stragglers exist ("N older pinned
items not shown — say 'include older pinned' to fold them in") so the user can opt in.

For a large pool (100+), classify in batches or fan out with the Workflow tool, but the
**rubric and the human-approval gate below never change**.

### 3. Classify against the rubric

Tag every candidate `share` or `keep`, with a one-line reason and a `category`. Flag any
builder/code-fix item explicitly as the hard exclusion. Note any candidate you would
*not* share because it is stale/conflicting, and say what needs resolving first.

### 4. Detect duplicates

Group candidates that state the same fact (often saved separately by several agents —
e.g. five copies of the clock rule). For each group, pick ONE canonical row to share and
mark the rest to supersede. Never share the same fact more than once.

### 5. Present the proposal and get approval

Show the user, grouped by category:
- the **share list** (canonical id(s), the fact, why it is safe + universal),
- the **duplicate groups** (which id is canonical, which get superseded),
- the **deliberately-held-back** items, especially anything hitting the hard exclusion,
- any **stale/conflict** items needing resolution before promotion.

Then ask with `AskUserQuestion` (`header: "Share plan"`, single-select):
- `Promote all + cleanup (Recommended)` — set the share list `shared = 1` and supersede dupes.
- `Promote, skip cleanup` — set `shared = 1` only, leave dupes as-is.
- `Let me trim first` — user removes ids before anything is written.

**Never write to the DB without an explicit yes.** This is the safety line — the skill only
ever proposes.

### 6. Apply (only after approval)

Wrap the writes in a single transaction. Show the user the affected rows first.

```bash
sqlite3 "$DB" "BEGIN; \
  UPDATE memories SET shared = 1 WHERE id IN (<approved canonical ids>); \
  UPDATE memories SET superseded_by = <canonical id> WHERE id IN (<dupe ids>); \
  COMMIT;"
```

- Promote canonical ids only; supersede confirmed duplicates so the shared tier stays clean.
- Do **not** touch stale/conflict items — surface them for the user to resolve separately.

### 7. Bump the marker file

After a run reaches a decision (promote, promote-skip-cleanup, trim, or even "share
nothing"), advance the high-water mark to the max id reviewed this run. Skip this only if the
user bailed before deciding. Stamp `last_run_at` from the system clock (a clock read is fine;
the no-infer rule is about guessing, not reading).

```bash
MAXID=$(sqlite3 "$DB" "SELECT max(id) FROM memories;")
NOW=$(date +%s)
cat > "$PROJECT_ROOT/store/memory-share-state.json" <<EOF
{ "last_reviewed_id": $MAXID, "last_run_at": $NOW, "promoted_total": <N promoted this run> }
EOF
```

### 8. Log and report

Log the action to `hive_mind` (action `memory-share`) so other agents see what was promoted,
then report a one-line summary: N facts promoted, M duplicates superseded, K held back,
new cutoff id.

## Safety rules

- Proposes, never auto-shares. Writes require an explicit user yes.
- The hard exclusion is absolute — builder/code-fix disposition never gets promoted even
  when the user is in a hurry. Say so if asked to override.
- Conservative default: if a candidate is borderline, keep it private. Nothing held back
  blocks any agent from doing its job.
- `agent_id` on a shared row is **provenance** (who learned it), not access control once
  `shared = 1`.
