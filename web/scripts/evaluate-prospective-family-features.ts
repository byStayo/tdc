import { fileURLToPath } from "node:url";
import { auditProspectiveRetailOutcomes } from "../lib/consensus/prospective-retail-outcomes.ts";
import { auditProspectiveFamilyOutcomes } from "../lib/consensus/prospective-family-outcomes.ts";

if (process.argv.length !== 2) throw new Error("Usage: evaluate-prospective-family-features.ts");
const root = fileURLToPath(new URL("../", import.meta.url));
const family = await auditProspectiveFamilyOutcomes(root);
console.log(JSON.stringify({ ...family, monthlyRetail: await auditProspectiveRetailOutcomes(root) }, null, 2));
