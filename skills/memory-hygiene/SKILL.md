---
name: memory-hygiene
description: Periodic memory-hygiene review of the agent memory store — recommends what to pin, what conflicts to resolve, what duplicates to collapse, and what stale items to let decay. Use for "/memory-hygiene", "memory hygiene review", "review my memories", "clean up memory", "what should be pinned", "any contradictory memories". Proposes a structured action plan across fixed recommendation buckets; never writes without approval.
user_invocable: true
---

# Memory Hygiene Review

A repeatable, **proposes-only** review of the memory store that always returns the same
recommendation buckets, so the output is predictable and "do bucket X" maps to a concrete
set of row writes. This is the spec that was missing — before it, the review was improvised
by feel and "let's do both" had nothing concrete behind it.

This pass owns the **whole store's health** (pin / conflict / dup / decay). The shared-tier
promotion is a **separate, narrower sub-step** — defer that entirely to the `memory-share`
skill. Do not re-implement share logic here.

## When to use

- On a cadence (the memory-hygiene cadence), or when the user asks for a memory cleanup.
- After a saga that left contradictory rows (e.g. a reversed technical decision) — the
  conflict bucket exists exactly for that.

## The store (ground every recommendation in these columns)

DB: `<repo-root>/store/claudeclaw.db`, table `memories`. Resolve `PROJECT_ROOT` first.

Levers that drive recommendations:
- `pinned` (0/1) — exempt from decay; reserved for facts that must never age out.
- `importance` (REAL 0..1) — static value weight.
- `salience` (REAL, default 1.0) — recall-decay weight; low + stale = natural drop candidate.
- `accessed_at` (epoch) — last recall; old + low importance = let it decay.
- `superseded_by` (FK) — the supersede mechanism for conflicts and duplicates.
- `shared` (0/1) — handled by `memory-share`, not here.

## The recommendation buckets (the heart of this skill)

Every review classifies candidates into these **fixed buckets**, in this order. Each item =
`{ids, current state, proposed action, one-line reason}`. This fixed set is what "the intended
recommendations" means — the user can approve any subset by bucket name.

1. **PIN** — facts that must never decay but are not pinned. Qualifying classes:
   core identity / agent roster + rename history, display-name architecture, per-agent role
   definitions, Mike-as-ClaudeClaw-specialist, system rules (clock/no-infer-dates, secrets
   never pushed, output-format constraints), infra paths, vault strategy, specialist
   appointments. → propose `pinned = 1`.

2. **CONFLICT** — two or more rows asserting contradictory *current truth* (e.g. reversed
   technical decision, two different "current branch" values). Resolve to ONE canonical row,
   supersede the losers. Never let both survive. → propose `superseded_by = <canonical>` on
   the stale ones. State which is canonical and why.

3. **DUPLICATE** — multiple rows stating the same fact. Keep one canonical, supersede the
   rest. → `superseded_by = <canonical>`.

4. **DECAY / PRUNE** — low value, safe to let go: `importance < 0.4` AND not pinned AND
   `accessed_at` old (e.g. > 90 days), plus point-in-time work logs / session checkpoints /
   resolved client notes. Default action is **leave unpinned so natural salience decay drops
   them**; only propose explicit supersede when an item is actively misleading.

5. **UNPIN** — currently `pinned = 1` but no longer warrants permanence (stale, superseded,
   or never met the PIN bar). → propose `pinned = 0`.

6. **RECALIBRATE** (optional) — clearly mis-scored importance (a critical rule at 0.4, trivia
   at 0.9). → propose new `importance`. Use sparingly; flag, don't churn.

7. **SHARE-TIER (handoff)** — note count of universal facts that may belong in the shared
   tier and recommend running `/memory-share`. Do not promote here.

## Steps

### 1. Pull the candidate pool

```bash
DB="$PROJECT_ROOT/store/claudeclaw.db"
[ -f "$DB" ] || { echo "DB not found"; exit 1; }

# Live, non-superseded rows for the active chat/agent set, richest signal first:
sqlite3 -json "$DB" "SELECT id, agent_id, pinned AS pin, importance AS imp, \
    round(salience,2) AS sal, date(accessed_at,'unixepoch') AS seen, summary AS s \
  FROM memories \
  WHERE superseded_by IS NULL \
  ORDER BY pinned DESC, importance DESC;"
```

Scope to one agent with `AND agent_id = '<agent>'` when asked. For a large pool, classify in
batches; the buckets and the approval gate never change.

### 2. Classify into the buckets

Walk the pool and tag each row into exactly one bucket above (or "OK, no action"). For
CONFLICT and DUPLICATE, group the related ids and name the canonical row. Be strict on PIN —
when unsure whether something is permanent, leave it to normal decay rather than pin it.

### 3. Present the proposal, grouped by bucket

Show the user, per bucket: the ids, the fact, the proposed action, and a one-line reason.
For CONFLICT, show both/all sides and which one wins. Make the row counts explicit so the
user can approve by bucket ("do PIN + CONFLICT", "skip DECAY").

Then gate with `AskUserQuestion` (`header: "Hygiene plan"`, allow multi-select of buckets, or
single-select Apply-all / Let-me-trim / Cancel). **Never write without an explicit yes.**

### 4. Apply (only after approval), one transaction

```bash
sqlite3 "$DB" "BEGIN; \
  UPDATE memories SET pinned = 1 WHERE id IN (<PIN ids>); \
  UPDATE memories SET superseded_by = <canon> WHERE id IN (<CONFLICT/DUP loser ids>); \
  UPDATE memories SET pinned = 0 WHERE id IN (<UNPIN ids>); \
  UPDATE memories SET importance = <v> WHERE id = <RECALIBRATE id>; \
  COMMIT;"
```

Show affected rows before committing. Apply only the buckets the user approved.

### 5. Log and report

Log to `hive_mind` (action `memory-hygiene`) so other agents see the cleanup, then report a
one-line summary: N pinned, M conflicts resolved, K dups collapsed, J left to decay, plus
whether a `/memory-share` run is recommended.

## Safety rules

- Proposes, never auto-writes. Every DB change needs an explicit yes.
- Conservative on PIN and on PRUNE — when in doubt, leave the row to normal decay; don't pin
  and don't hard-supersede a merely-old item.
- Conflicts must resolve to exactly one canonical truth before any supersede write.
- Shared-tier promotion is out of scope — hand off to `memory-share`.
