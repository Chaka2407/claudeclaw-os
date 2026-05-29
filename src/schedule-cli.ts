#!/usr/bin/env node
/**
 * ClaudeClaw Schedule CLI
 *
 * Used by your Claude assistant via the Bash tool to manage scheduled tasks.
 *
 * Usage:
 *   node dist/schedule-cli.js create "prompt text" "0 9 * * 1"
 *   node dist/schedule-cli.js create --pre-check 'bash cmd' "prompt" "cron"
 *   node dist/schedule-cli.js create --model claude-haiku-4-5 "prompt" "cron"
 *   node dist/schedule-cli.js update <id> --pre-check 'bash cmd'
 *   node dist/schedule-cli.js update <id> --model claude-haiku-4-5   (--model "" clears it)
 *   node dist/schedule-cli.js list
 *   node dist/schedule-cli.js delete <id>
 *   node dist/schedule-cli.js pause <id>
 *   node dist/schedule-cli.js resume <id>
 *
 * --pre-check: a bash command run before the LLM. If it exits non-zero or
 *              produces no output, the agent call is skipped for that firing.
 */

import { randomBytes } from 'crypto';

import {
  initDatabase,
  createScheduledTask,
  getAllScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
} from './db.js';
import { DEFAULT_TIMEZONE } from './config.js';
import { computeNextRun } from './scheduler.js';

initDatabase();

// Parse --agent flag from anywhere in argv, fall back to CLAUDECLAW_AGENT_ID env var
const agentFlagIdx = process.argv.indexOf('--agent');
const cliAgentId = agentFlagIdx !== -1
  ? process.argv[agentFlagIdx + 1] ?? 'main'
  : process.env.CLAUDECLAW_AGENT_ID ?? 'main';
// Parse --timezone flag, default to America/New_York (EST/EDT)
const tzFlagIdx = process.argv.indexOf('--timezone');
const cliTimezone = tzFlagIdx !== -1
  ? process.argv[tzFlagIdx + 1] ?? DEFAULT_TIMEZONE
  : DEFAULT_TIMEZONE;
// Parse --pre-check flag (optional bash command to gate LLM invocation)
const preCheckFlagIdx = process.argv.indexOf('--pre-check');
const cliPreCheck = preCheckFlagIdx !== -1 ? process.argv[preCheckFlagIdx + 1] : undefined;
// Parse --model flag (optional per-task model override, e.g. claude-haiku-4-5)
const modelFlagIdx = process.argv.indexOf('--model');
const cliModel = modelFlagIdx !== -1 ? process.argv[modelFlagIdx + 1] : undefined;
// Remove all named flags and their values from positional args
const flagIndices = new Set<number>();
if (agentFlagIdx !== -1) { flagIndices.add(agentFlagIdx); flagIndices.add(agentFlagIdx + 1); }
if (tzFlagIdx !== -1) { flagIndices.add(tzFlagIdx); flagIndices.add(tzFlagIdx + 1); }
if (preCheckFlagIdx !== -1) { flagIndices.add(preCheckFlagIdx); flagIndices.add(preCheckFlagIdx + 1); }
if (modelFlagIdx !== -1) { flagIndices.add(modelFlagIdx); flagIndices.add(modelFlagIdx + 1); }
const cleanedArgv = flagIndices.size > 0
  ? process.argv.filter((_, i) => !flagIndices.has(i))
  : [...process.argv];
const [, , command, ...rest] = cleanedArgv;

function formatDate(unix: number | null, tz = DEFAULT_TIMEZONE): string {
  if (!unix) return 'never';
  return new Date(unix * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: tz,
  });
}

switch (command) {
  case 'create': {
    const prompt = rest[0];
    const cron = rest[1];

    if (!prompt || !cron) {
      console.error('Usage: schedule-cli create "prompt" "cron expression"');
      console.error('Example: schedule-cli create "Summarise AI news" "0 9 * * 1"');
      process.exit(1);
    }

    let nextRun: number;
    try {
      nextRun = computeNextRun(cron, cliTimezone);
    } catch {
      console.error(`Invalid cron expression: "${cron}"`);
      console.error('Examples: "0 9 * * 1" (Mon 9am)  "0 8 * * *" (daily 8am)  "0 */4 * * *" (every 4h)');
      process.exit(1);
    }

    const id = randomBytes(4).toString('hex');
    createScheduledTask(id, prompt, cron, nextRun, cliAgentId, cliTimezone, cliPreCheck, cliModel);

    console.log(`Task created: ${id}`);
    console.log(`Agent:        ${cliAgentId}`);
    console.log(`Prompt:       ${prompt}`);
    console.log(`Schedule:     ${cron}`);
    console.log(`Timezone:     ${cliTimezone}`);
    console.log(`Next run:     ${formatDate(nextRun)}`);
    if (cliPreCheck) console.log(`Pre-check:    ${cliPreCheck}`);
    if (cliModel) console.log(`Model:        ${cliModel}`);
    break;
  }

  case 'list': {
    const tasks = getAllScheduledTasks(cliAgentId === 'main' ? undefined : cliAgentId);
    if (tasks.length === 0) {
      console.log('No scheduled tasks.');
      break;
    }
    console.log(`${tasks.length} scheduled task${tasks.length === 1 ? '' : 's'}:\n`);
    for (const t of tasks) {
      const tz = t.timezone || DEFAULT_TIMEZONE;
      const status = t.status === 'paused' ? ' [PAUSED]' : '';
      console.log(`${t.id}${status}`);
      console.log(`  Prompt:   ${t.prompt}`);
      console.log(`  Schedule:  ${t.schedule}`);
      console.log(`  Timezone:  ${tz}`);
      console.log(`  Next run:  ${formatDate(t.next_run, tz)}`);
      console.log(`  Last run:  ${formatDate(t.last_run, tz)}`);
      if (t.pre_check) console.log(`  Pre-check: ${t.pre_check}`);
      if (t.model) console.log(`  Model:     ${t.model}`);
      console.log();
    }
    break;
  }

  case 'delete': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli delete <id>'); process.exit(1); }
    deleteScheduledTask(id);
    console.log(`Deleted task: ${id}`);
    break;
  }

  case 'pause': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli pause <id>'); process.exit(1); }
    pauseScheduledTask(id);
    console.log(`Paused task: ${id}`);
    break;
  }

  case 'resume': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli resume <id>'); process.exit(1); }
    resumeScheduledTask(id);
    console.log(`Resumed task: ${id}`);
    break;
  }

  case 'update': {
    const id = rest[0];
    if (!id) {
      console.error('Usage: schedule-cli update <id> [--pre-check <cmd>] [--model <id>] [--prompt <text>] [--schedule <cron>]');
      process.exit(1);
    }
    const patch: Parameters<typeof updateScheduledTask>[1] = {};
    if (cliPreCheck !== undefined) patch.preCheck = cliPreCheck;
    // Allow clearing model with --model "" (empty string → NULL = agent default)
    if (cliModel !== undefined) patch.model = cliModel === '' ? null : cliModel;
    // Allow clearing pre-check with --pre-check ""
    const promptFlagIdx = process.argv.indexOf('--prompt');
    if (promptFlagIdx !== -1) patch.prompt = process.argv[promptFlagIdx + 1];
    const scheduleFlagIdx = process.argv.indexOf('--schedule');
    if (scheduleFlagIdx !== -1) {
      patch.schedule = process.argv[scheduleFlagIdx + 1];
      patch.nextRun = computeNextRun(patch.schedule, cliTimezone);
    }
    if (Object.keys(patch).length === 0) {
      console.error('Nothing to update. Use --pre-check, --model, --prompt, or --schedule.');
      process.exit(1);
    }
    updateScheduledTask(id, patch);
    console.log(`Updated task: ${id}`);
    if ('preCheck' in patch) console.log(`Pre-check: ${patch.preCheck ?? '(cleared)'}`);
    if ('model' in patch) console.log(`Model: ${patch.model ?? '(cleared — agent default)'}`);
    break;
  }

  default:
    console.error('Commands: create | list | update | delete | pause | resume');
    process.exit(1);
}
