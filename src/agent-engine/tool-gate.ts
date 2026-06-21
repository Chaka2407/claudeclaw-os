// Composable tool-permission gate for the agent engine.
//
// A host (e.g. an overlay action-gate / policy scorer) registers a single gate
// that the SDK adapter consults for EVERY tool call, BEFORE the built-in
// AskUserQuestion bridge. Returning `deny` blocks the tool and surfaces the
// message to the model; `allow` lets the next layer decide. Unregistered (the
// default) means no gating — pure upstream behaviour.
//
// This is the generic extension point; the proprietary scoring logic lives in
// the overlay and is wired in via registerToolGate at startup.

export type ToolGateResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type ToolGate = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<ToolGateResult>;

let registeredGate: ToolGate | undefined;

/** Register the process-wide tool gate (e.g. from an overlay bootstrap). */
export function registerToolGate(gate: ToolGate): void {
  registeredGate = gate;
}

/** Clear the registered tool gate (mainly for tests). */
export function clearToolGate(): void {
  registeredGate = undefined;
}

/** The registered tool gate, if any. */
export function getToolGate(): ToolGate | undefined {
  return registeredGate;
}
