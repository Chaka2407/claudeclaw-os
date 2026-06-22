import { describe, it, expect } from 'vitest';

import { passesPreCheck, isSilentOutput } from './scheduler.js';

// Regression coverage for the polling-task quiet behavior that the comms
// WhatsApp check depends on: when a pre-check shell command reports "nothing
// to do", the LLM call must be skipped entirely; and when an agent emits
// [SILENT], its output must not be delivered to Telegram.

describe('passesPreCheck', () => {
  it('proceeds when there is no pre-check configured', () => {
    expect(passesPreCheck(null)).toBe(true);
    expect(passesPreCheck(undefined)).toBe(true);
    expect(passesPreCheck('')).toBe(true);
  });

  it('skips when the command exits 0 but produces no output', () => {
    // `true` succeeds with empty stdout — the classic "nothing happened" gate.
    expect(passesPreCheck('true')).toBe(false);
  });

  it('skips when the command exits non-zero', () => {
    expect(passesPreCheck('false')).toBe(false);
  });

  it('proceeds when the command prints output', () => {
    expect(passesPreCheck('echo hi')).toBe(true);
  });

  it('matches the WhatsApp poll gate: 0 new messages → skip', () => {
    // Mirrors the live pre_check shape: count piped through grep -v '^0$'.
    expect(passesPreCheck("echo 0 | grep -v '^0$'")).toBe(false);
  });

  it('matches the WhatsApp poll gate: >0 new messages → proceed', () => {
    expect(passesPreCheck("echo 2 | grep -v '^0$'")).toBe(true);
  });
});

describe('isSilentOutput', () => {
  it('detects the [SILENT] sentinel prefix', () => {
    expect(isSilentOutput('[SILENT]')).toBe(true);
    expect(isSilentOutput('[SILENT] trailing junk')).toBe(true);
  });

  it('treats normal output as deliverable', () => {
    expect(isSilentOutput('No new messages')).toBe(false);
    expect(isSilentOutput('Auto-replied to Sam')).toBe(false);
  });
});
