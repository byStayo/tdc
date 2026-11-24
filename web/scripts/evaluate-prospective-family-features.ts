import { fileURLToPath } from "node:url";
import { auditProspectiveFamilyOutcomes } from "../lib/consensus/prospective-family-outcomes.ts";

if (process.argv.length !== 2) throw new Error("Usage: evaluate-prospective-family-features.ts");
const root = fileURLToPath(new URL("../", import.meta.url));
console.log(JSON.stringify(await auditProspectiveFamilyOutcomes(root), null, 2));
