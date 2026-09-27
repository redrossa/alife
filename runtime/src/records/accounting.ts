// Conservative cost accounting (plan §11.2): one upper per-token rate per
// direction for the selected model. Every request reserves its maximum cost
// before it is sent; a known response is charged from its reported usage, and
// an unknown outcome keeps the whole reservation. Amounts are integer
// micro-dollars, rounded up, so sums never lose a fraction to floating point.
//
// This is not a pricing catalog or an invoice: the accounted cost can exceed
// what the provider eventually bills, never the reverse under the declared rates.

export interface CostRates {
  readonly inputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
  /** Where the rates come from, recorded with every reservation. */
  readonly source: string;
  /** When the rates were last checked against the provider's published prices. */
  readonly verifiedOn?: string;
}

/** The fake mind sends nothing anywhere, so nothing can be billed. */
export const FAKE_MIND_RATES: CostRates = {
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  source: "fake mind: no provider request is made",
};

export interface Reservation {
  readonly requestId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly microUsd: number;
}

export interface LedgerState {
  readonly limitMicroUsd: number;
  /** Settled charges, including reservations kept because the outcome is unknown. */
  readonly accountedMicroUsd: number;
  readonly outstanding: readonly Reservation[];
}

export type Settlement =
  | { readonly basis: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  /** The provider certainly did not process the request. */
  | { readonly basis: "not_processed" }
  /** Usage or completion is unknown: the full reservation is kept. */
  | { readonly basis: "unknown" };

/** Upper cost of `tokens` at `usdPerMillion`, in micro-dollars: one token costs `usdPerMillion` micro-dollars. */
export function microUsd(tokens: number, usdPerMillion: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new RangeError(`invalid token count ${tokens}`);
  return Math.ceil(tokens * usdPerMillion);
}

export class CostLedger {
  readonly rates: CostRates;
  readonly #limit: number;
  #accounted: number;
  readonly #outstanding = new Map<string, Reservation>();

  constructor(limitUsd: number, rates: CostRates, state: LedgerState | null = null) {
    this.rates = rates;
    this.#limit = state?.limitMicroUsd ?? Math.floor(limitUsd * 1e6);
    this.#accounted = state?.accountedMicroUsd ?? 0;
    for (const reservation of state?.outstanding ?? []) this.#outstanding.set(reservation.requestId, reservation);
  }

  #cost(inputTokens: number, outputTokens: number): number {
    return microUsd(inputTokens, this.rates.inputUsdPerMillionTokens) + microUsd(outputTokens, this.rates.outputUsdPerMillionTokens);
  }

  get remainingMicroUsd(): number {
    let outstanding = 0;
    for (const reservation of this.#outstanding.values()) outstanding += reservation.microUsd;
    return this.#limit - this.#accounted - outstanding;
  }

  /** Reserves the request's maximum cost, or returns null (reserving nothing) if it does not fit. */
  reserve(requestId: string, inputTokens: number, outputTokens: number): Reservation | null {
    if (this.#outstanding.has(requestId)) throw new Error(`request ${requestId} already has a reservation`);
    const reservation: Reservation = { requestId, inputTokens, outputTokens, microUsd: this.#cost(inputTokens, outputTokens) };
    if (reservation.microUsd > this.remainingMicroUsd) return null;
    this.#outstanding.set(requestId, reservation);
    return reservation;
  }

  /** Settles a reservation and returns the charge. Usage above the reservation is charged in full. */
  settle(requestId: string, settlement: Settlement): number {
    const reservation = this.#outstanding.get(requestId);
    if (reservation === undefined) throw new Error(`request ${requestId} has no outstanding reservation`);
    const charge =
      settlement.basis === "usage"
        ? this.#cost(settlement.inputTokens, settlement.outputTokens)
        : settlement.basis === "unknown"
          ? reservation.microUsd
          : 0;
    this.#outstanding.delete(requestId);
    this.#accounted += charge;
    return charge;
  }

  snapshot(): LedgerState {
    return { limitMicroUsd: this.#limit, accountedMicroUsd: this.#accounted, outstanding: [...this.#outstanding.values()] };
  }
}
