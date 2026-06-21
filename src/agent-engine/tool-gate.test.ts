import { describe, it, expect, afterEach } from 'vitest';

import { registerToolGate, getToolGate, clearToolGate } from './tool-gate.js';

afterEach(() => clearToolGate());

describe('tool-gate registry', () => {
  it('returns undefined when no gate is registered (default)', () => {
    expect(getToolGate()).toBeUndefined();
  });

  it('registers and returns a gate, invocable with a deny result', async () => {
    const gate = async () => ({ behavior: 'deny' as const, message: 'blocked' });
    registerToolGate(gate);
    const g = getToolGate();
    expect(g).toBe(gate);
    expect(await g!('Bash', { command: 'rm -rf /' })).toEqual({
      behavior: 'deny',
      message: 'blocked',
    });
  });

  it('clears the registered gate', () => {
    registerToolGate(async () => ({ behavior: 'allow' as const }));
    clearToolGate();
    expect(getToolGate()).toBeUndefined();
  });
});
