import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { prepareKibotPrimary, registerKibotPrimary } from "../lib/consensus/kibot-eod-primary.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 1 || !["--choose-primary", "--resume-default", "--scheduled"].includes(args[0]))
  throw Error("Usage: consensus:kibot-eod -- --choose-primary | --resume-default | --scheduled");
const release = await acquirePublicationLock(root, "kibot-subscriber-daily");
let failure: { error: unknown } | undefined;
try {
  const result = args[0] === "--scheduled" ? await prepareKibotPrimary(root) :
    await registerKibotPrimary(root, args[0] === "--choose-primary" ? "choose-primary" : "resume-default").then(policy =>
      ({ selected: !!policy && policy.changes.at(-1)?.action !== "resume-default",
        effectiveAfter: policy?.changes.at(-1)?.recordedAt ?? policy?.registeredAt ?? null }));
  console.log(JSON.stringify(result));
} catch (error) { failure = { error }; throw error; }
finally { await finishPublicationLock(release, failure); }
