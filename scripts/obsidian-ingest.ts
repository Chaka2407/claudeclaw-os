/**
 * Obsidian Vault Memory Ingestion
 *
 * Walks your Obsidian vault, extracts meaningful facts from each note,
 * and saves them to the ClaudeClaw memory database. Supports incremental
 * runs — only reprocesses files that have changed since the last run.
 *
 * Usage:
 *   tsx scripts/obsidian-ingest.ts [options]
 *
 * Options:
 *   --vault <path>      Vault path (default: reads from agent.yaml or CLAUDE.md)
 *   --chat-id <id>      Chat ID to store memories under (default: reads from DB sessions)
 *   --agent-id <id>     Agent ID (default: main)
 *   --dry-run           Extract and print without saving to DB
 *   --force             Reprocess all files, ignoring state cache
 *   --folder <name>     Only process a specific folder (can repeat)
 *   --delay <ms>        Delay between API calls in ms (default: 1000)
 */

import fs from 'fs';
import path from 'path';

import { initDatabase, saveStructuredMemoryAtomic, getMemoriesWithEmbeddings } from '../src/db.js';
import { embedText, cosineSimilarity } from '../src/embeddings.js';
import { generateContent, parseJsonResponse } from '../src/gemini.js';

// ── CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

function getArgAll(flag: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) results.push(args[i + 1]);
  }
  return results;
}

const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const DELAY_MS = parseInt(getArg('--delay') ?? '1000', 10);
const MAX_FILES = parseInt(getArg('--max') ?? '0', 10); // 0 = no limit
const AGENT_ID = getArg('--agent-id') ?? 'main';
const FOLDER_FILTER = getArgAll('--folder');

// ── Config ────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const STATE_FILE = path.join(PROJECT_ROOT, 'store', 'obsidian-ingest-state.json');

// Folders to skip entirely
const SKIP_FOLDERS = new Set(['Archive', 'Templates', '.obsidian', 'node_modules', '.git']);

// File extensions to process
const VALID_EXTENSIONS = new Set(['.md']);

// Max content length to send to the extraction model
const MAX_NOTE_LENGTH = 4000;

// Similarity threshold for duplicate detection
const DUPLICATE_THRESHOLD = 0.85;

// ── State tracking ────────────────────────────────────────────────────

interface IngestState {
  files: Record<string, { mtime: number; memoriesCreated: number; lastRun: number }>;
}

function loadState(): IngestState {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as IngestState;
    } catch {
      return { files: {} };
    }
  }
  return { files: {} };
}

function saveState(state: IngestState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Extraction prompt ─────────────────────────────────────────────────

const VAULT_EXTRACTION_PROMPT = `You are a knowledge extraction agent. Given the content of a personal knowledge base note, extract facts worth storing as long-term memories.

The bar is HIGH. Only extract facts that would meaningfully help a personal AI assistant understand this person better in future conversations.

SKIP (return {"skip": true}) if:
- The note is a template with placeholder text
- It's a daily/weekly log with only ephemeral entries
- It's a collection of links or references with no personal context
- It's purely technical documentation with no personal decisions or preferences
- The note is empty or has less than 3 meaningful sentences
- It's a meeting transcript or notes with no lasting conclusions

EXTRACT if the note reveals:
- Project goals, current status, key decisions, and next steps
- People the user works with and their relationship/role
- Standing preferences, rules, or workflows the user follows
- Business or creative strategy decisions
- Personal values, working style, or priorities
- Technical architecture decisions or tool choices
- Problems being solved and the chosen approach

For each extractable fact, produce ONE memory entry. If a note has multiple distinct facts, you may return multiple entries (up to 5).

Return JSON:
{
  "skip": false,
  "memories": [
    {
      "summary": "1-2 sentence fact written as a standing rule or fact, not a narrative. Start with subject.",
      "entities": ["person or project name", "tool name"],
      "topics": ["topic1", "topic2"],
      "importance": 0.0-1.0
    }
  ]
}

Importance guide:
- 0.8-1.0: Core project strategy, key relationships, critical decisions, strong preferences
- 0.5-0.7: Active project status, workflows, moderate preferences, tool choices
- 0.3-0.4: Borderline — only include if clearly useful in a future session

Note title: {TITLE}
Note content:
{CONTENT}`;

// ── Extraction ────────────────────────────────────────────────────────

interface VaultMemory {
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
}

interface ExtractionResult {
  skip?: boolean;
  memories?: VaultMemory[];
}

async function extractMemoriesFromNote(
  title: string,
  content: string,
): Promise<VaultMemory[]> {
  const truncated = content.length > MAX_NOTE_LENGTH
    ? content.slice(0, MAX_NOTE_LENGTH) + '\n\n[Note truncated]'
    : content;

  const prompt = VAULT_EXTRACTION_PROMPT
    .replace('{TITLE}', title)
    .replace('{CONTENT}', truncated);

  let raw: string;
  try {
    raw = await generateContent(prompt, 'gemini-2.5-flash');
  } catch (err) {
    console.error(`  extraction error (${title}):`, err instanceof Error ? err.message : err);
    return [];
  }

  const result = parseJsonResponse<ExtractionResult>(raw);
  if (!result || result.skip) return [];

  const memories = result.memories ?? [];
  return memories.filter((m) => m.importance >= 0.5 && m.summary?.length > 10);
}

// ── Vault walking ─────────────────────────────────────────────────────

interface NoteFile {
  filePath: string;
  title: string;
  folder: string;
  mtime: number;
}

function walkVault(vaultPath: string, folderFilter: string[]): NoteFile[] {
  const results: NoteFile[] = [];

  function walk(dir: string, relativeFolder: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (SKIP_FOLDERS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (folderFilter.length > 0 && !folderFilter.includes(entry.name)) continue;
        walk(fullPath, entry.name);
      } else if (entry.isFile() && VALID_EXTENSIONS.has(path.extname(entry.name))) {
        try {
          const stat = fs.statSync(fullPath);
          const title = path.basename(entry.name, path.extname(entry.name));
          results.push({
            filePath: fullPath,
            title,
            folder: relativeFolder || '(root)',
            mtime: Math.floor(stat.mtimeMs),
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(vaultPath, '');
  return results;
}

// ── Duplicate detection ───────────────────────────────────────────────

async function isDuplicate(
  chatId: string,
  embedding: number[],
): Promise<boolean> {
  if (embedding.length === 0) return false;
  const existing = getMemoriesWithEmbeddings(chatId);
  for (const mem of existing) {
    const sim = cosineSimilarity(embedding, mem.embedding);
    if (sim > DUPLICATE_THRESHOLD) return true;
  }
  return false;
}

// ── Resolve vault path ────────────────────────────────────────────────

function resolveVaultPath(): string | undefined {
  // 1. CLI arg
  const cliVault = getArg('--vault');
  if (cliVault) return cliVault;

  // 2. Check ~/.claudeclaw/CLAUDE.md for vault path
  const claudeclaw = path.join(process.env.HOME ?? '', '.claudeclaw', 'CLAUDE.md');
  if (fs.existsSync(claudeclaw)) {
    const content = fs.readFileSync(claudeclaw, 'utf-8');
    const match = content.match(/\*\*Obsidian vault:\*\*\s+[`']?([^`'\n]+)[`']?/);
    if (match?.[1]) return match[1].trim().replace(/\s*\(.*?\)$/, '').trim();
  }

  // 3. Check agent.yaml
  const agentYaml = path.join(PROJECT_ROOT, 'agents', AGENT_ID, 'agent.yaml');
  if (fs.existsSync(agentYaml)) {
    const content = fs.readFileSync(agentYaml, 'utf-8');
    const match = content.match(/vault:\s+(.+)/);
    if (match?.[1]) return match[1].trim().replace(/['"]/g, '');
  }

  return undefined;
}

// ── Resolve chat_id ───────────────────────────────────────────────────

async function resolveChatId(): Promise<string | undefined> {
  const cliId = getArg('--chat-id');
  if (cliId) return cliId;

  // Try reading from DB sessions
  try {
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');
    if (fs.existsSync(dbPath)) {
      const tempDb = new Database(dbPath, { readonly: true });
      const row = tempDb.prepare(
        'SELECT chat_id FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1',
      ).get(AGENT_ID) as { chat_id: string } | undefined;
      tempDb.close();
      if (row?.chat_id) return row.chat_id;
    }
  } catch {
    // ignore
  }

  return undefined;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🧠 Obsidian Vault Memory Ingestion');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`   Agent: ${AGENT_ID}`);
  if (FORCE) console.log('   Force: reprocessing all files');

  // Resolve vault path
  const vaultPath = resolveVaultPath();
  if (!vaultPath) {
    console.error('\n❌ Could not find vault path. Pass --vault <path> or set it in ~/.claudeclaw/CLAUDE.md');
    process.exit(1);
  }
  if (!fs.existsSync(vaultPath)) {
    console.error(`\n❌ Vault path does not exist: ${vaultPath}`);
    process.exit(1);
  }
  console.log(`   Vault: ${vaultPath}`);

  // Resolve chat_id
  const chatId = await resolveChatId();
  if (!chatId) {
    console.error('\n❌ Could not determine chat_id. Pass --chat-id <id> or make sure the bot has been used at least once.');
    process.exit(1);
  }
  console.log(`   Chat ID: ${chatId}\n`);

  // Init DB
  if (!DRY_RUN) {
    initDatabase();
  }

  // Load state
  const state = FORCE ? { files: {} } : loadState();

  // Walk vault
  const notes = walkVault(vaultPath, FOLDER_FILTER);
  console.log(`📂 Found ${notes.length} notes`);

  // Filter to changed/new files
  const toProcess = FORCE
    ? notes
    : notes.filter((n) => {
        const cached = state.files[n.filePath];
        return !cached || cached.mtime !== n.mtime;
      });

  const cappedToProcess = MAX_FILES > 0 ? toProcess.slice(0, MAX_FILES) : toProcess;
  const skippedCount = notes.length - toProcess.length;
  const capMsg = MAX_FILES > 0 ? ` (capped at ${MAX_FILES})` : '';
  console.log(`✅ ${skippedCount} unchanged (skipping) | 🔄 ${cappedToProcess.length} to process${capMsg}\n`);

  if (cappedToProcess.length === 0) {
    console.log('Nothing to do. Use --force to reprocess everything.');
    return;
  }

  // Process each note
  let totalMemories = 0;
  let totalSkipped = 0;
  let totalDuplicates = 0;

  for (let i = 0; i < cappedToProcess.length; i++) {
    const note = cappedToProcess[i];
    const progress = `[${i + 1}/${cappedToProcess.length}]`;

    let content: string;
    try {
      content = fs.readFileSync(note.filePath, 'utf-8');
    } catch {
      console.log(`${progress} ⚠️  Could not read: ${note.title}`);
      continue;
    }

    // Skip empty or very short notes
    if (content.trim().length < 50) {
      console.log(`${progress} ⏭️  Too short: ${note.title}`);
      state.files[note.filePath] = { mtime: note.mtime, memoriesCreated: 0, lastRun: Date.now() };
      continue;
    }

    process.stdout.write(`${progress} 🔍 ${note.folder}/${note.title}... `);

    const memories = await extractMemoriesFromNote(note.title, content);

    if (memories.length === 0) {
      console.log('skipped (nothing extractable)');
      totalSkipped++;
      state.files[note.filePath] = { mtime: note.mtime, memoriesCreated: 0, lastRun: Date.now() };
      if (!DRY_RUN) saveState(state);
      await sleep(DELAY_MS);
      continue;
    }

    let savedCount = 0;
    for (const mem of memories) {
      // Generate embedding
      let embedding: number[] = [];
      try {
        const embText = `${mem.summary} ${mem.entities.join(' ')} ${mem.topics.join(' ')}`;
        embedding = await embedText(embText);
      } catch {
        // proceed without embedding
      }

      if (DRY_RUN) {
        console.log(`\n   📝 [DRY RUN] importance=${mem.importance.toFixed(2)}`);
        console.log(`      ${mem.summary}`);
        savedCount++;
        continue;
      }

      // Duplicate check
      if (await isDuplicate(chatId, embedding)) {
        totalDuplicates++;
        continue;
      }

      saveStructuredMemoryAtomic(
        chatId,
        `[Obsidian: ${note.title}]\n${content.slice(0, 500)}`,
        mem.summary,
        mem.entities,
        mem.topics,
        mem.importance,
        embedding,
        'obsidian',
        AGENT_ID,
      );
      savedCount++;
      totalMemories++;
    }

    if (DRY_RUN) {
      // already printed inline
    } else {
      console.log(`${savedCount} memories saved`);
    }

    state.files[note.filePath] = { mtime: note.mtime, memoriesCreated: savedCount, lastRun: Date.now() };
    if (!DRY_RUN) saveState(state);

    await sleep(DELAY_MS);
  }

  console.log('\n── Summary ─────────────────────────────');
  console.log(`   Notes processed : ${cappedToProcess.length}`);
  console.log(`   Memories saved  : ${totalMemories}`);
  console.log(`   Duplicates skip : ${totalDuplicates}`);
  console.log(`   Notes skipped   : ${totalSkipped}`);
  if (DRY_RUN) console.log('\n   (DRY RUN — nothing was written to the DB)');
  console.log('────────────────────────────────────────');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
