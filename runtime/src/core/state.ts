// Run lifecycle (plan §12). States and stop reasons are separate: a state says
// what may happen next, a reason says why the run stopped. No reason is
// described as organism mortality.

export const RUN_STATES = [
  "created",
  "ready",
  "running",
  "stopping",
  "stopped_clean",
  "completed",
  "recovery_required",
  "finalized",
] as const;

export type RunState = (typeof RUN_STATES)[number];

const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  // Configuration resolved and records created; the world is not yet attached.
  // A run whose world never started ends here: `completed` when the world is
  // verified not running, `recovery_required` when that is unknown.
  created: ["ready", "completed", "recovery_required"],
  // World attached and identity verified; nothing has been sent or executed.
  ready: ["running", "completed", "recovery_required"],
  // An unclean end (crash, lost engine, uncertain action) skips `stopping`.
  running: ["stopping", "recovery_required"],
  // `stopped_clean` only after every operation is resolved and the world stop
  // is verified; `completed` when a declared limit ended the run.
  stopping: ["stopped_clean", "completed", "recovery_required"],
  // Clean resume. Resume never follows `recovery_required`. A resume whose
  // new world epoch failed to start ends here too: `completed` when that
  // start was cleaned up verifiably, `recovery_required` otherwise.
  stopped_clean: ["running", "completed", "recovery_required"],
  completed: [],
  // Closed by an operator acknowledging the recorded uncertainty.
  recovery_required: ["finalized"],
  finalized: [],
};

/** Lifecycle event recorded when a run enters each state. */
export const STATE_EVENTS = {
  created: "run.created",
  ready: "run.ready",
  running: "run.started",
  stopping: "run.stopping",
  stopped_clean: "run.stopped_clean",
  completed: "run.completed",
  recovery_required: "run.recovery_required",
  finalized: "run.finalized",
} as const satisfies Record<RunState, `run.${string}`>;

export function allowedTransitions(from: RunState): readonly RunState[] {
  return TRANSITIONS[from];
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState) {
    super(`illegal run transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function transition(from: RunState, to: RunState): RunState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

export function isTerminal(state: RunState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Only a verified clean stop can be resumed. */
export function isResumable(state: RunState): boolean {
  return state === "stopped_clean";
}

export const STOP_REASONS = [
  "operator_stop",
  "tick_limit",
  "deadline",
  "spend_limit",
  "record_capacity",
  "host_capacity",
  "protocol_error_threshold",
  "provider_failure",
  "world_exit",
  "world_oom",
  "engine_lost",
  "watchdog_expired",
  "uncertain_action",
  "uncertain_signal",
  "record_corruption",
  "record_failure",
  "controller_interrupted",
  "context_overflow",
  "request_invalid",
  "world_start_failed",
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

/**
 * Where a run goes after a clean stop for `reason`: `stopped_clean` (may be
 * resumed) when the stop came from outside the run's own limits, otherwise
 * `completed`. Uncertainty always leads to `recovery_required` instead.
 */
export function cleanEndState(reason: StopReason): "stopped_clean" | "completed" {
  return reason === "operator_stop" || reason === "provider_failure" ? "stopped_clean" : "completed";
}
