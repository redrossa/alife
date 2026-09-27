import type { AppendOptions } from "../core/contracts.ts";
import type { UncertainEffect } from "../core/execution-safety.ts";
import type { EventType } from "./events.ts";

// The run's one writer of `action.uncertain` evidence for effects whose
// outcome became uncertain (Phase 3 lifecycle plan §7.2). Used by the loop
// when it detects uncertainty and by run finalization when the stop
// assessment reports it. It records the earlier affected actions, never a
// command that was refused because of them; it deduplicates by action; an
// entry counts as recorded only after its append succeeded; and a failure is
// kept for finalization instead of preventing the world from being stopped.

export type Discovery = "observation" | "before_request" | "dispatch" | "before_stop" | "stop";

type Append = (type: EventType, data: Readonly<Record<string, unknown>>, options?: AppendOptions) => Promise<number>;

export class UncertaintyRecorder {
  readonly #append: Append;
  readonly #recorded = new Set<string>();
  #failed = false;

  constructor(append: Append) {
    this.#append = append;
  }

  /** False once any uncertainty evidence could not be recorded. */
  get complete(): boolean {
    return !this.#failed;
  }

  /** The action's own outcome record already says its result is uncertain. */
  markRecorded(actionId: string): void {
    this.#recorded.add(actionId);
  }

  /** Records each effect not yet recorded. Never throws; returns whether everything is now recorded. */
  async record(effects: readonly UncertainEffect[], discovered: Discovery, tick: number | null): Promise<boolean> {
    for (const effect of effects) {
      if (this.#recorded.has(effect.actionId)) continue;
      try {
        await this.#append(
          "action.uncertain",
          {
            actionId: effect.actionId,
            jobId: effect.jobId,
            execId: effect.execId,
            state: "uncertain",
            cause: effect.cause,
            firstObservedAt: effect.firstObservedAt,
            discovered,
            detail: effect.detail,
          },
          tick === null ? { durable: true } : { tick, durable: true },
        );
        this.#recorded.add(effect.actionId);
      } catch {
        this.#failed = true;
      }
    }
    return effects.every((effect) => this.#recorded.has(effect.actionId));
  }
}
