import { describe, it, expect, beforeEach, vi } from 'vitest';

// #96 follow-up: MEMORY_RECALL_MODE env seed. This file pins the env value to
// 'shared' (simulating an upgrading install that set MEMORY_RECALL_MODE=shared in
// .env) so we can assert the precedence rules. db.test.ts covers the default and
// the explicit-toggle round-trip with the real (isolated) env value, so the two
// files must not share a module registry — hence the separate file + mock.
vi.mock('./config.js', async (importActual) => {
  const actual = await importActual<typeof import('./config.js')>();
  return { ...actual, MEMORY_RECALL_MODE_ENV: 'shared' as const };
});

const { _initTestDatabase, getMemoryRecallMode, setMemoryRecallMode } = await import('./db.js');

describe('memory recall mode — env seed precedence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('falls back to the env seed when no dashboard row is set', () => {
    // No setMemoryRecallMode() call → no dashboard_settings row → env seed wins.
    expect(getMemoryRecallMode()).toBe('shared');
  });

  it('an explicit dashboard toggle overrides the env seed', () => {
    setMemoryRecallMode('isolated');
    expect(getMemoryRecallMode()).toBe('isolated');
    setMemoryRecallMode('shared');
    expect(getMemoryRecallMode()).toBe('shared');
  });
});
