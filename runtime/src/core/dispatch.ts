import type { ReviewCause, UncertainEffect } from "./execution-safety.ts";

// Refusals a world backend reports when a shell action is submitted. Both
// mean the command was never started, so the harness can report them as
// known outcomes rather than uncertainty.

/** Rejected before anything was created in the world. */
export class JobAdmissionError extends Error {
  constructor(active: number, limit: number) {
    super(
      `${active} jobs are running, still collecting output, or finished but not yet reported in an observation; ` +
        `the limit is ${limit}, so nothing was dispatched`,
    );
    this.name = "JobAdmissionError";
  }
}

/** The command was never started: the pre-dispatch record or the engine refused. */
export class DispatchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchRefusedError";
  }
}

/**
 * Refused because the execution epoch requires review: an earlier effect's
 * outcome is uncertain, or required evidence could not be recorded. Nothing
 * more is dispatched in this epoch. `effects` are the earlier affected jobs,
 * never the refused command itself.
 */
export class UncertainJobsError extends DispatchRefusedError {
  readonly effects: readonly UncertainEffect[];
  readonly evidenceFailed: boolean;

  constructor(effects: readonly UncertainEffect[], evidenceFailed: boolean, causes: readonly ReviewCause[] = []) {
    const what = [
      ...(effects.length > 0 ? [`the outcome of ${effects.map((effect) => effect.jobId).join(", ")} is uncertain`] : []),
      ...(causes.length > 0 ? [`a signal's delivery is unknown (${causes.map((cause) => cause.jobId).join(", ")})`] : []),
      ...(evidenceFailed ? ["required evidence could not be recorded"] : []),
    ];
    super(`${what.join(", and ") || "the world requires review"}; nothing more is dispatched until the world is reviewed`);
    this.name = "UncertainJobsError";
    this.effects = effects;
    this.evidenceFailed = evidenceFailed;
  }

  get jobIds(): readonly string[] {
    return this.effects.map((effect) => effect.jobId);
  }
}
