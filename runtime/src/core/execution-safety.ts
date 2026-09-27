// The execution epoch's safety condition (Phase 3 lifecycle plan). One object
// per world execution epoch, owned by the world controller and shared with its
// job table. It remembers established uncertainty as a lasting fact of the
// epoch, independently of any job's current process state:
//
// - I1: once an effect's outcome is uncertain, the epoch requires review for
//   the rest of its life; nothing clears it.
// - I2: admission of new agent effects closes at the first issue and never
//   reopens within the epoch; callers check it at the commitment point.
// - I4: only a sealed assessment, made after shutdown processing, can support
//   a clean checkpoint.
// - I5: the condition is latched synchronously, before any attempt to record it.
//
// This file has no Docker or provider types, no I/O, and no clock.

export type UncertaintyCause =
  /** The engine no longer knows an execution that was started. */
  | "execution_lost"
  /** A dispatched start could not be established as started or not. */
  | "start_outcome_unknown";

export interface UncertainEffect {
  readonly actionId: string;
  readonly jobId: string;
  readonly execId: string | null;
  readonly cause: UncertaintyCause;
  readonly firstObservedAt: string;
  /** Bounded text, never an error object. */
  readonly detail: string;
}

/**
 * A review-required fact that is not an agent action's outcome: for example, a
 * signal (agent- or operator-requested) whose delivery cannot be established.
 * It is attributed to its own operation, never presented as a model action.
 */
export interface ReviewCause {
  readonly operationId: string;
  readonly kind: "signal_delivery_unknown";
  readonly jobId: string;
  readonly requestedBy: "agent" | "operator";
  readonly firstObservedAt: string;
  /** Bounded text, never an error object. */
  readonly detail: string;
}

export interface ExecutionSafetySnapshot {
  readonly epochId: string;
  readonly admission: "open" | "closed";
  /** True whenever anything prevents certifying the epoch as cleanly accounted for. */
  readonly reviewRequired: boolean;
  readonly uncertainEffects: readonly UncertainEffect[];
  /** Other review-required facts of the epoch, such as a signal whose delivery is unknown. */
  readonly reviewCauses: readonly ReviewCause[];
  /** A required world record could not be written (or evidence exceeded its bound). */
  readonly requiredEvidenceFailed: boolean;
  /** Effects committed to the transport in this epoch. */
  readonly committedEffects: number;
}

export interface StopSafetyAssessment extends ExecutionSafetySnapshot {
  /**
   * True only when made after the epoch's shutdown processing finished: no
   * further observation or required world record can change it.
   */
  readonly sealed: boolean;
}

const DETAIL_BYTES = 512;

function bounded(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= DETAIL_BYTES) return text;
  let out = "";
  let bytes = 3;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > DETAIL_BYTES) break;
    out += char;
    bytes += size;
  }
  return `${out}…`;
}

export class SealedSafetyError extends Error {
  constructor(what: string) {
    super(`the execution epoch's safety assessment is sealed; ${what} after sealing is an invariant violation`);
    this.name = "SealedSafetyError";
  }
}

export class ExecutionSafety {
  readonly epochId: string;
  /** At most this many uncertain effects are kept; more fails closed as incomplete evidence. */
  readonly maximumEffects: number;
  readonly #effects = new Map<string, UncertainEffect>();
  readonly #causes = new Map<string, ReviewCause>();
  #admissionOpen = true;
  #evidenceFailed = false;
  #committed = 0;
  #sealed: StopSafetyAssessment | null = null;

  constructor(options: { readonly epochId: string; readonly maximumEffects: number }) {
    if (options.epochId.length === 0 || options.epochId.length > 128) throw new RangeError("invalid epoch ID");
    if (!Number.isSafeInteger(options.maximumEffects) || options.maximumEffects < 1 || options.maximumEffects > 4096) {
      throw new RangeError(`invalid uncertain-effect bound ${options.maximumEffects}`);
    }
    this.epochId = options.epochId;
    this.maximumEffects = options.maximumEffects;
  }

  #mutable(what: string): void {
    if (this.#sealed !== null) throw new SealedSafetyError(what);
  }

  /**
   * Records an uncertain effect and closes admission, synchronously. Idempotent
   * by job: the first observation is kept. Beyond the bound, evidence is
   * marked incomplete rather than dropped silently.
   */
  latchUncertainty(effect: UncertainEffect): void {
    this.#mutable("latching uncertainty");
    this.#admissionOpen = false;
    if (this.#effects.has(effect.jobId)) return;
    if (this.#effects.size >= this.maximumEffects) {
      this.#evidenceFailed = true;
      return;
    }
    this.#effects.set(effect.jobId, Object.freeze({ ...effect, detail: bounded(effect.detail) }));
  }

  /**
   * Records a review-required fact about an operation that is not an agent
   * action, synchronously. Idempotent by operation; bounded like effects.
   * Agent admission closes; operator interventions before shutdown remain the
   * caller's decision.
   */
  latchReview(cause: ReviewCause): void {
    this.#mutable("latching a review cause");
    if (this.#causes.has(cause.operationId)) return;
    if (this.#causes.size >= this.maximumEffects) {
      this.#evidenceFailed = true;
      return;
    }
    this.#causes.set(cause.operationId, Object.freeze({ ...cause, detail: bounded(cause.detail) }));
  }

  /** A required record failed: monotonic, and it closes admission. */
  markRequiredEvidenceFailure(): void {
    this.#mutable("marking evidence failure");
    this.#evidenceFailed = true;
    this.#admissionOpen = false;
  }

  /** Irreversible within the epoch. */
  closeAdmission(): void {
    this.#admissionOpen = false;
  }

  /** Counts an effect handed to the transport (its commitment point). */
  noteCommitted(): void {
    this.#mutable("committing an effect");
    this.#committed += 1;
  }

  get reviewRequired(): boolean {
    return this.#effects.size > 0 || this.#causes.size > 0 || this.#evidenceFailed;
  }

  /** Admission is open only while nothing has closed it and nothing requires review. */
  get admissionOpen(): boolean {
    return this.#admissionOpen && !this.reviewRequired;
  }

  get sealed(): boolean {
    return this.#sealed !== null;
  }

  /** An immutable copy. No refresh or I/O. */
  snapshot(): ExecutionSafetySnapshot {
    return Object.freeze({
      epochId: this.epochId,
      admission: this.admissionOpen ? "open" : "closed",
      reviewRequired: this.reviewRequired,
      uncertainEffects: Object.freeze([...this.#effects.values()]),
      reviewCauses: Object.freeze([...this.#causes.values()]),
      requiredEvidenceFailed: this.#evidenceFailed,
      committedEffects: this.#committed,
    });
  }

  /**
   * An unsealed assessment, for stops that failed or could not be verified:
   * observations remain possible, so it always requires review.
   */
  provisional(): StopSafetyAssessment {
    return this.#sealed ?? Object.freeze({ ...this.snapshot(), reviewRequired: true, sealed: false });
  }

  /**
   * Seals the epoch after its shutdown processing. The result is final; any
   * later mutation throws. Sealing twice returns the same assessment.
   */
  seal(): StopSafetyAssessment {
    this.#admissionOpen = false;
    this.#sealed ??= Object.freeze({ ...this.snapshot(), sealed: true });
    return this.#sealed;
  }
}

/** For a stop with no execution epoch in this controller (for example, an operator stopping an orphaned world). */
export function noEpochAssessment(requiredEvidenceFailed: boolean): StopSafetyAssessment {
  return Object.freeze({
    epochId: "none",
    admission: "closed",
    // Without an epoch, nothing about earlier executions is known: never certifiable as clean.
    reviewRequired: true,
    uncertainEffects: Object.freeze([]),
    reviewCauses: Object.freeze([]),
    requiredEvidenceFailed,
    committedEffects: 0,
    sealed: false,
  });
}

/** A checkpoint may rely on an assessment only if it is sealed, review-free, and of the expected epoch. */
export function certifiesClean(assessment: StopSafetyAssessment, epochId: string): boolean {
  return (
    assessment.sealed &&
    assessment.epochId === epochId &&
    !assessment.reviewRequired &&
    assessment.uncertainEffects.length === 0 &&
    assessment.reviewCauses.length === 0 &&
    !assessment.requiredEvidenceFailed
  );
}
