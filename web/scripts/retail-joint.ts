import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { publisherSecondaryStudies } from "../lib/consensus/secondary-studies.ts";
import { collectAuctionStudyOnly } from "../lib/consensus/auction-dispersion-study.ts";
import { secondaryFamilyStudies } from "../lib/consensus/secondary-family-studies.ts";

const flags = process.argv.slice(2);
const group = ["--premarket", "--fund-flows", "--analysts", "--institutions", "--international", "--events", "--families", "--all"].includes(flags[0]) ? flags[0] : "--retail";
if (group !== "--retail") flags.shift();
const [action = "--status", ...extra] = flags;
if (extra.length || (!["--register", "--status", "--advance"].includes(action) && !(group === "--events" && action === "--capture")))
  throw Error("Choose --status, --register, --advance, or --capture for the Treasury events study");
if (group === "--all" && action !== "--status") throw Error("The all-family inventory supports --status only");
const root = fileURLToPath(new URL("../", import.meta.url));
const selected = group === "--all" ? publisherSecondaryStudies : group === "--families" ? secondaryFamilyStudies :
  publisherSecondaryStudies.filter(({name}) => name === group.slice(2));
async function run() {
  if (action === "--capture") {
    console.log(JSON.stringify(await collectAuctionStudyOnly(root), null, 2));
    return;
  }
  const reports = [];
  for (const {name, study} of selected) {
    if (action === "--register") await study.register(root);
    reports.push({ family: name, report: await study.status(root, action === "--advance") });
  }
  console.log(JSON.stringify(group === "--all" || group === "--families" ? reports : reports[0].report, null, 2));
}
if (action === "--status") await run();
else {
  const release = await acquirePublicationLock(root, "private-secondary-" + group.slice(2));
  let failure;
  try { await run(); }
  catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(release, failure); }
}
