import assert from "node:assert/strict";
import { campaignAPI, reservation } from "./phase5-campaign.ts";

const [directory, campaignId] = process.argv.slice(2);
assert.ok(directory && campaignId, "child requires an existing campaign");
const api = await campaignAPI();
const campaign = await api.openCampaign({ directory, campaignId });
assert.deepEqual(await campaign.reserve(reservation(70)), reservation(70));
// The parent kills us only after durable admission; there is deliberately no close/recovery.
assert.equal(typeof process.send, "function");
process.send?.({ type: "reserved", snapshot: await campaign.snapshot() });
setInterval(() => undefined, 60_000);
