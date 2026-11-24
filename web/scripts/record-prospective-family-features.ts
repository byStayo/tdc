import { recordProspectiveFamilyFeatures } from "../lib/consensus/prospective-family-features.ts";

const args = process.argv.slice(2);
if (args.length !== 2) throw new Error("Usage: record-prospective-family-features.ts YYYY-MM-DD EDITION_ID");
const result = await recordProspectiveFamilyFeatures(process.cwd(), args[0], args[1]);
console.log(JSON.stringify(result, null, 2));
