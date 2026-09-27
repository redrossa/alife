import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { forward } from "./phase5-contract.ts";

export interface CampaignReservation {
  readonly runId: string;
  readonly requestId: string;
  readonly maximumMicroUsd: number;
}
export interface CampaignSnapshot {
  readonly campaignId: string;
  readonly limitMicroUsd: number;
  readonly accountedMicroUsd: number;
  readonly outstanding: readonly CampaignReservation[];
  readonly remainingMicroUsd: number;
  readonly reviewRequired: boolean;
}
export type CampaignSettlement = { readonly runId: string; readonly requestId: string } & (
  | { readonly basis: "usage"; readonly chargedMicroUsd: number }
  | { readonly basis: "unknown" | "not_processed" }
);
export interface Campaign {
  close(): Promise<void>;
  snapshot(): Promise<CampaignSnapshot>;
  reserve(reservation: CampaignReservation): Promise<CampaignReservation | null>;
  settle(settlement: CampaignSettlement): Promise<void>;
}
export interface CampaignLocation {
  readonly directory: string;
  readonly campaignId: string;
}
export interface CreateCampaignOptions extends CampaignLocation {
  readonly limitMicroUsd: number;
  readonly maximumBytes: number;
}
export interface CampaignAPI {
  createCampaign(options: CreateCampaignOptions): Promise<Campaign>;
  openCampaign(options: CampaignLocation): Promise<Campaign>;
}
export function campaignAPI(): Promise<CampaignAPI> {
  return forward("../../src/records/campaign.ts", ["createCampaign", "openCampaign"]);
}
export const CAMPAIGN_ID = "phase5-offline";
export const RUN_A = "r-20260925T161449Z-00000001";
export const RUN_B = "r-20260925T161449Z-00000002";
export function reservation(maximumMicroUsd = 40, tick = 1, runId = RUN_A): CampaignReservation {
  return { runId, requestId: `${runId}.t${String(tick).padStart(6, "0")}.request`, maximumMicroUsd };
}
// On-disk public contract for deliberate corruption probes. No lock filename is prescribed.
export function campaignFiles(directory: string) {
  return { metadata: path.join(directory, "metadata.json"), journal: path.join(directory, "journal.jsonl") };
}
export async function fixture(t: TestContext, overrides: Partial<CreateCampaignOptions> = {}) {
  // Check the forward contract BEFORE any negative assertion can accidentally pass on module absence.
  const api = await campaignAPI();
  const root = await mkdtemp(path.join(tmpdir(), "alife-phase5-campaign-"));
  const owners: Campaign[] = [];
  t.after(async () => {
    await Promise.all(owners.map((owner) => owner.close().catch(() => undefined)));
    await rm(root, { recursive: true, force: true });
  });
  const options: CreateCampaignOptions = {
    directory: path.join(root, "campaign"), campaignId: CAMPAIGN_ID,
    limitMicroUsd: 100, maximumBytes: 1 << 20, ...overrides,
  };
  function track(owner: Campaign): Campaign { owners.push(owner); return owner; }
  return { api, root, options, files: campaignFiles(options.directory),
    create: async () => track(await api.createCampaign(options)),
    reopen: async () => track(await api.openCampaign({ directory: options.directory, campaignId: options.campaignId })),
    track,
  };
}
export async function assertBlocked(owner: Campaign, request: CampaignReservation): Promise<void> {
  // Resource exhaustion/review can reject or return null, but must never admit an effect.
  const result = await owner.reserve(request).then((value) => ({ value }), () => ({ value: null }));
  assert.equal(result.value, null);
}
