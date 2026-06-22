#!/bin/bash
# briefing-digest.sh — deterministic data-gathering for the morning priority briefing.
#
# Emits a compact text digest (a few thousand tokens) so the briefing agent can do a
# single formatting pass instead of reading hot.md + every project file in full across
# ~25 agentic turns. No LLM is invoked here — just calendar, sqlite, git, and file parsing.
#
# Sources:
#   - Today's Google Calendar (gcal.py)
#   - Active projects: vault_index table  ∪  hot.md Active-section wikilinks  (deduped by path)
#   - Per project: frontmatter (priority/status/dates), ## ⏰ Hard Deadlines table,
#     ## Milestones rows due within 14 days and not Done, and git last-modified (staleness)
#   - hot.md's Runway Banner + Active section verbatim (the priority-ordering signal)

set -uo pipefail

# The agent runs as a systemd user service with a minimal PATH that excludes
# user-installed bins (e.g. ~/.npm-global/bin where `gws` lives). Prepend them
# so tools resolve the same way they do in an interactive shell. Uses $HOME so
# it stays portable across machines.
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

CLAUDECLAW_DIR="${CLAUDECLAW_DIR:-/home/chaka/projects/claudeclaw-os}"
VAULT="${VAULT:-/home/chaka/projects/second-brain-vault}"
DB="$CLAUDECLAW_DIR/store/claudeclaw.db"

TODAY_ISO="$(date +%Y-%m-%d)"
TODAY_DAY="$(date +%A)"

echo "=== BRIEFING DIGEST — ${TODAY_ISO} (${TODAY_DAY}) ==="
echo

echo "=== TODAY'S CALENDAR ==="
CAL_OUT="$(CLAUDECLAW_DIR="$CLAUDECLAW_DIR" ~/.venv/bin/python3 ~/.config/calendar/gcal.py list --days 1 2>/dev/null)"
if [ -z "$CAL_OUT" ] || [ "$CAL_OUT" = "[]" ]; then
  echo "No calendar events today."
else
  echo "$CAL_OUT"
fi
echo

echo "=== OUTSTANDING GOOGLE TASKS (all incomplete) ==="
# Pulled via the gws CLI (Tasks scope). Degrades gracefully if gws auth is stale.
python3 <<'TASKEOF'
import json, subprocess


def gws(args):
    try:
        r = subprocess.run(["gws", *args, "--format", "json"],
                           capture_output=True, text=True, timeout=30)
    except Exception:
        return None
    if r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def items_of(resp):
    if isinstance(resp, dict):
        if "error" in resp:
            return None
        return resp.get("items", [])
    if isinstance(resp, list):
        return resp
    return None


try:
    lists = items_of(gws(["tasks", "tasklists", "list"]))
    if lists is None:
        print("(Google Tasks unavailable — run 'gws auth login' to refresh auth)")
    else:
        any_task = False
        for tl in lists:
            lid = tl.get("id")
            lname = tl.get("title", "Tasks")
            params = json.dumps({"tasklist": lid, "showCompleted": False, "maxResults": 100})
            tasks = items_of(gws(["tasks", "tasks", "list", "--params", params])) or []
            rows = []
            for t in tasks:
                if t.get("status") == "completed":
                    continue
                title = (t.get("title") or "").strip()
                if not title:
                    continue
                due = (t.get("due") or "")[:10]  # YYYY-MM-DD, may be empty
                rows.append((due or "9999-99-99", title, due))
            if rows:
                any_task = True
                print(f"## {lname}")
                for _, title, due in sorted(rows):
                    print(f"  - {title}  (due {due})" if due else f"  - {title}")
                if len(rows) >= 100:
                    print("  - (list capped at 100 — more not shown)")
        if not any_task:
            print("No outstanding tasks.")
except Exception as e:
    print(f"(Google Tasks unavailable — {type(e).__name__})")
TASKEOF
echo

# Everything else (sqlite query, hot.md parse + wikilink resolution, per-project
# frontmatter/deadline/milestone extraction, git staleness) runs in one Python pass.
VAULT="$VAULT" DB="$DB" python3 <<'PYEOF'
import os, re, sqlite3, subprocess
from datetime import date, datetime

VAULT = os.environ["VAULT"]
DB = os.environ["DB"]
PROJECTS = os.path.join(VAULT, "Projects")
TODAY = date.today()
HORIZON = 14  # days

DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


def read(path):
    try:
        with open(os.path.join(VAULT, path), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def section(text, header):
    """Return the lines of a '## <header>' section up to the next '## ' header."""
    lines = text.splitlines()
    out, capturing = [], False
    for ln in lines:
        if ln.startswith("## "):
            if capturing:
                break
            if ln[3:].strip().startswith(header):
                capturing = True
                continue
        if capturing:
            out.append(ln)
    return out


def frontmatter(text):
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    block = text[3:end] if end != -1 else ""
    fm = {}
    for ln in block.splitlines():
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", ln)
        if m:
            fm[m.group(1)] = m.group(2).strip()
    return fm


def table_rows(text, header):
    """Markdown table '|' rows inside a '## <header...>' section (incl. emoji headers)."""
    lines = text.splitlines()
    out, capturing = [], False
    for ln in lines:
        if ln.startswith("## "):
            if capturing:
                break
            if header in ln:
                capturing = True
                continue
        if capturing and ln.lstrip().startswith("|"):
            out.append(ln)
    return out


def cells(row):
    return [c.strip() for c in row.strip().strip("|").split("|")]


def git_last_mod(path):
    try:
        out = subprocess.run(
            ["git", "-C", VAULT, "log", "-1", "--format=%cI", "--", path],
            capture_output=True, text=True, timeout=15,
        ).stdout.strip()
        if not out:
            return None
        return datetime.strptime(out[:10], "%Y-%m-%d").date()
    except Exception:
        return None


# ── 1. Build the active-project set from BOTH sources, deduped by path ──────────────
paths = {}  # relpath -> title

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
for p, t in con.execute(
    "SELECT path, title FROM vault_index "
    "WHERE path LIKE 'Projects/%' AND (status='active' OR status IS NULL)"
):
    paths[p] = t
con.close()

# Basename -> relpath index of every project file, for wikilink resolution.
basename_index = {}
for root, _, files in os.walk(PROJECTS):
    for f in files:
        if f.endswith(".md"):
            rel = os.path.relpath(os.path.join(root, f), VAULT)
            basename_index.setdefault(f[:-3], rel)

hot = read("hot.md")
active_lines = section(hot, "Active")
for ln in active_lines:
    # Drop struck-through (archived) entries before extracting links.
    clean = re.sub(r"~~.*?~~", "", ln)
    for name in WIKILINK_RE.findall(clean):
        name = name.split("|")[0].split("#")[0].strip()
        rel = basename_index.get(name)
        if rel and rel not in paths:
            paths[rel] = name  # title falls back to the wikilink name

# ── 2. hot.md priority context (Runway Banner + Active section, verbatim) ───────────
print("=== HOT.MD PRIORITY CONTEXT (ordering signal — weight items in this order) ===")
banner = section(hot, "⏰ 3-Month Runway Banner")
if banner:
    print("## Runway Banner")
    print("\n".join(l for l in banner if l.strip()))
    print()
print("## Active")
print("\n".join(l for l in active_lines if l.strip()))
print()

# ── 3. Per-project compact extract ──────────────────────────────────────────────────
print("=== ACTIVE PROJECTS (%d) ===" % len(paths))
print()

for path in sorted(paths, key=lambda p: paths[p].lower()):
    text = read(path)
    fm = frontmatter(text)
    title = fm.get("title") or paths[path]
    priority = fm.get("priority", "—")

    lm = git_last_mod(path)
    if lm is not None:
        age = (TODAY - lm).days
        stale = "  ⚠️ STALE" if age >= 14 else ""
        lm_str = f"{lm.isoformat()} ({age}d ago){stale}"
    else:
        lm_str = "unknown"

    print(f"### {title}  [priority: {priority}]")
    print(f"path: {path}")
    print(f"last-modified: {lm_str}")
    bits = [f"{k}: {fm[k]}" for k in ("status", "date", "updated") if fm.get(k)]
    if bits:
        print("frontmatter: " + " | ".join(bits))

    # Hard deadlines (Date | Event | ...). Keep date + event only.
    hd = table_rows(text, "Hard Deadlines")
    hd_out = []
    for row in hd:
        c = cells(row)
        if len(c) < 2 or set(c[0]) <= set("-: ") or not re.search(r"\d{4}", c[0]):
            continue
        hd_out.append(f"  - {c[0]}: {c[1]}")
    if hd_out:
        print("HARD DEADLINES:")
        print("\n".join(hd_out))

    # Milestones due within HORIZON days and not Done.
    ms = table_rows(text, "Milestones")
    ms_out = []
    for row in ms:
        if "✅" in row or "Done" in row:
            continue
        m = DATE_RE.search(row)
        if not m:
            continue
        d = datetime.strptime(m.group(1), "%Y-%m-%d").date()
        days = (d - TODAY).days
        # Upcoming 14 days, plus a 7-day grace for just-missed deadlines.
        # Deeper overdue items are stale noise; the staleness flag covers them.
        if days > HORIZON or days < -7:
            continue
        c = cells(row)
        name = c[1] if len(c) > 1 else row.strip()
        name = re.sub(r"\s+", " ", name)[:140]
        tag = "OVERDUE" if days < 0 else f"{days}d"
        ms_out.append((days, f"  - due {m.group(1)} ({tag}): {name}"))
    if ms_out:
        print("MILESTONES (due ≤14d, not done):")
        for _, line in sorted(ms_out):
            print(line)

    print()
PYEOF
