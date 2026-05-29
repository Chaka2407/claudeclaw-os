import { spawnSync } from 'child_process';

import { CronExpressionParser } from 'cron-parser';

import { AGENT_ID, ALLOWED_CHAT_ID, DEFAULT_TIMEZONE, agentMcpAllowlist } from './config.js';
import {
  getDueTasks,
  getSession,
  logConversationTurn,
  markTaskRunning,
  updateTaskAfterRun,
  resetStuckTasks,
  claimNextMissionTask,
  completeMissionTask,
  resetStuckMissionTasks,
  getMissionTask,
} from './db.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { runAgent } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';

type Sender = (text: string) => Promise<void>;

/** Max time (ms) a scheduled task can run before being killed. */
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

let sender: Sender;

/**
 * In-memory set of task IDs currently being executed.
 * Acts as a fast-path guard alongside the DB-level lock in markTaskRunning.
 */
const runningTaskIds = new Set<string>();

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
let schedulerAgentId = 'main';

export function initScheduler(send: Sender, agentId = 'main'): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  schedulerAgentId = agentId;

  // Recover tasks stuck in 'running' from a previous crash
  const recovered = resetStuckTasks(agentId);
  if (recovered > 0) {
    logger.warn({ recovered, agentId }, 'Reset stuck tasks from previous crash');
  }
  const recoveredMission = resetStuckMissionTasks(agentId);
  if (recoveredMission > 0) {
    logger.warn({ recovered: recoveredMission, agentId }, 'Reset stuck mission tasks from previous crash');
  }

  setInterval(() => void runDueTasks(), 60_000);
  logger.info({ agentId }, 'Scheduler started (checking every 60s)');
}

async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks(schedulerAgentId);

  if (tasks.length > 0) {
    logger.info({ count: tasks.length }, 'Running due scheduled tasks');
  }

  for (const task of tasks) {
    // In-memory guard: skip if already running in this process
    if (runningTaskIds.has(task.id)) {
      logger.warn({ taskId: task.id }, 'Task already running, skipping duplicate fire');
      continue;
    }

    // Compute next occurrence BEFORE executing so we can lock the task
    // in the DB immediately, preventing re-fire on subsequent ticks.
    const nextRun = computeNextRun(task.schedule, task.timezone || DEFAULT_TIMEZONE);
    runningTaskIds.add(task.id);
    markTaskRunning(task.id, nextRun);

    logger.info({ taskId: task.id, prompt: task.prompt.slice(0, 60) }, 'Firing task');

    // Route through the message queue so scheduled tasks wait for any
    // in-flight user message to finish before running. This prevents
    // two Claude processes from hitting the same session simultaneously.
    const chatId = ALLOWED_CHAT_ID || 'scheduler';
    messageQueue.enqueue(chatId, async () => {
      // Pre-check: run a cheap shell command before spinning up the LLM.
      // If it exits non-zero or produces no output, skip this firing entirely.
      if (task.pre_check) {
        const result = spawnSync('bash', ['-c', task.pre_check], { encoding: 'utf8' });
        const hasOutput = result.status === 0 && result.stdout.trim().length > 0;
        if (!hasOutput) {
          updateTaskAfterRun(task.id, nextRun, '', 'success');
          runningTaskIds.delete(task.id);
          logger.debug({ taskId: task.id }, 'Task pre-check returned nothing — skipping agent call');
          return;
        }
      }

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

      try {
        // Run as a fresh agent call (no session — scheduled tasks are autonomous)
        const result = await runAgent(task.prompt, undefined, () => {}, undefined, undefined, abortController, undefined, agentMcpAllowlist);
        clearTimeout(timeout);

        if (result.aborted) {
          updateTaskAfterRun(task.id, nextRun, 'Timed out after 10 minutes', 'timeout');
          await sender(`⏱ Task timed out after 10m: "${task.prompt.slice(0, 60)}..." — killed.`);
          logger.warn({ taskId: task.id }, 'Task timed out');
          return;
        }

        // runAgent already recovers the final assistant text from the session
        // transcript when the SDK's result event is empty (e.g. the agent made
        // a tool call after answering, or hit the max-turns cap). See agent.ts.
        const text = result.text?.trim() || 'Task completed with no output.';

        // If the agent signals [SILENT], skip sending to Telegram but still
        // log to DB. This lets polling tasks stay quiet when nothing happened.
        const isSilent = text.includes('[SILENT]');

        if (!isSilent) {
          for (const chunk of splitMessage(formatForTelegram(text))) {
            await sender(chunk);
          }
        } else {
          logger.info({ taskId: task.id }, 'Task output suppressed ([SILENT])');
        }

        // Inject task output into the active chat session so user replies have context
        if (ALLOWED_CHAT_ID && !isSilent) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', `[Scheduled task]: ${task.prompt}`, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }

        updateTaskAfterRun(task.id, nextRun, isSilent ? '' : text, 'success');

        logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
      } catch (err) {
        clearTimeout(timeout);
        const errMsg = err instanceof Error ? err.message : String(err);
        updateTaskAfterRun(task.id, nextRun, errMsg.slice(0, 500), 'failed');

        logger.error({ err, taskId: task.id }, 'Scheduled task failed');
        try {
          await sender(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
        } catch {
          // ignore send failure
        }
      } finally {
        runningTaskIds.delete(task.id);
      }
    });
  }

  // Also check for queued mission tasks (one-shot async tasks from Mission Control)
  await runDueMissionTasks();
}

async function runDueMissionTasks(): Promise<void> {
  const mission = claimNextMissionTask(schedulerAgentId);
  if (!mission) return;

  const missionKey = 'mission-' + mission.id;
  if (runningTaskIds.has(missionKey)) return;
  runningTaskIds.add(missionKey);

  logger.info({ missionId: mission.id, title: mission.title }, 'Running mission task');

  const chatId = ALLOWED_CHAT_ID || 'mission';
  messageQueue.enqueue(chatId, async () => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

    // Cross-process cancel signal: dashboard flips status to 'cancelled' in
    // SQLite, this poll picks it up within 5s and aborts the runAgent call.
    let cancelledByUser = false;
    const cancelPoll = setInterval(() => {
      const current = getMissionTask(mission.id);
      if (current?.status === 'cancelled') {
        cancelledByUser = true;
        abortController.abort();
        clearInterval(cancelPoll);
      }
    }, 5_000);

    try {
      const result = await runAgent(mission.prompt, undefined, () => {}, undefined, undefined, abortController, undefined, agentMcpAllowlist);
      clearTimeout(timeout);
      clearInterval(cancelPoll);

      if (result.aborted) {
        if (cancelledByUser) {
          // Status is already 'cancelled' from the dashboard write — leave it.
          logger.info({ missionId: mission.id }, 'Mission task cancelled by user');
        } else {
          completeMissionTask(mission.id, null, 'failed', 'Timed out after 10 minutes');
          logger.warn({ missionId: mission.id }, 'Mission task timed out');
          try {
            await sender('Mission task timed out: "' + mission.title + '"');
          } catch (sendErr) {
            // Sender can fail for Telegram API blips or chat-not-found. We
            // still want to see it so the user isn't silently unnotified.
            logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission timeout notification');
          }
        }
      } else {
        const text = result.text?.trim() || 'Task completed with no output.';
        completeMissionTask(mission.id, text, 'completed');
        logger.info({ missionId: mission.id }, 'Mission task completed');

        // Send result to Telegram
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject into conversation context so agent can reference it
        if (ALLOWED_CHAT_ID) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', '[Mission task: ' + mission.title + ']: ' + mission.prompt, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (cancelledByUser) {
        logger.info({ missionId: mission.id }, 'Mission task cancelled by user (threw on abort)');
      } else {
        completeMissionTask(mission.id, null, 'failed', errMsg.slice(0, 500));
        logger.error({ err, missionId: mission.id }, 'Mission task failed');
      }
    } finally {
      clearInterval(cancelPoll);
      runningTaskIds.delete(missionKey);
    }
  });
}

export function computeNextRun(cronExpression: string, timezone = DEFAULT_TIMEZONE): number {
  const interval = CronExpressionParser.parse(cronExpression, { tz: timezone });
  return Math.floor(interval.next().getTime() / 1000);
}
