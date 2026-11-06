import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { acquirePublicationLock, finishPublicationLock } from "../publication-lock.ts";
import { recoverEvaluationTransaction, commitEvaluationTransaction } from "./evaluation-transaction.ts";
import { readReservations, validateActiveModelTree } from "./learning-audit.ts";
import { ENGINE_VERSION } from "./registry.ts";
import { INSTRUMENTS, HORIZONS, type Instrument, type Horizon } from "./types.ts";
import type { ActiveModel } from "./model.ts";
import type { PerformanceReport } from "./performance-types.ts";

/** A rollback changes future activation only. Its supplied reason is a public audit record. */
export async function rollbackActiveModel(root: string, input: { instrument: Instrument; horizon: Horizon; to: string; reason: string }) {
  if (!INSTRUMENTS.includes(input.instrument) || input.instrument === "MARKET" || !HORIZONS.includes(input.horizon) ||
      !input.reason.trim() || input.reason.length > 400 ||
      (input.to !== "none" && !/^[A-Z]+-(daily|weekly|monthly)-[a-f0-9]{16}$/.test(input.to)))
    throw new Error("Specify instrument, horizon, archived model id or none, and a public reason (1–400 characters)");
  const release = await acquirePublicationLock(root, "model-rollback");
  let failure: { error: unknown } | undefined;
  try {
    await recoverEvaluationTransaction(root);
    const registry = JSON.parse(await readFile(resolve(root, "lib/consensus/models.json"), "utf8")) as { schemaVersion: number; models: ActiveModel[]; note: string };
    const matches = registry.models.filter(model => model.instrument === input.instrument && model.horizon === input.horizon);
    if (matches.length > 1) throw new Error("Ambiguous active-model cohort");
    const previous = matches[0];
    let restored: ActiveModel | null = null;
    if (input.to !== "none") {
      restored = JSON.parse(await readFile(resolve(root, "public/consensus/models", `active-${input.to}.json`), "utf8")) as ActiveModel;
      if (restored.id !== input.to || restored.instrument !== input.instrument || restored.horizon !== input.horizon || restored.engineVersion !== ENGINE_VERSION || restored.trainedAt > new Date().toISOString())
        throw new Error("Rollback target does not match the current engine and cohort");
      await validateActiveModelTree(root, restored, await readReservations(root));
    }
    if ((previous?.id ?? null) === (restored?.id ?? null)) return { changed: false, modelId: restored?.id ?? null };
    const now = new Date().toISOString();
    registry.models = [...registry.models.filter(model => model.instrument !== input.instrument || model.horizon !== input.horizon), ...(restored ? [restored] : [])];
    registry.note = "Activation was explicitly rolled back. Immutable prior models, forecasts, outcomes and consumed evaluation windows remain preserved.";
    const report = JSON.parse(await readFile(resolve(root, "lib/consensus/performance.json"), "utf8")) as PerformanceReport;
    report.generatedAt = now;
    report.learning = report.learning.map(row => row.instrument === input.instrument && row.horizon === input.horizon
      ? { ...row, activeModelId: restored?.id ?? null, promoted: false, reason: `Activation rollback: ${input.reason.trim()}` } : row);
    const action = { id: randomUUID(), at: now, type: "rollback", instrument: input.instrument, horizon: input.horizon, engineVersion: ENGINE_VERSION,
      previousModelId: previous?.id ?? null, restoredModelId: restored?.id ?? null, reason: input.reason.trim() };
    await commitEvaluationTransaction(root, [
      { path: `public/consensus/model-actions/${action.id}.json`, value: action, immutable: true },
      { path: "lib/consensus/models.json", value: registry },
      { path: "lib/consensus/performance.json", value: report },
    ]);
    return { changed: true, modelId: restored?.id ?? null, action: action.id };
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(release, failure); }
}
