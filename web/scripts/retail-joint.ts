import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { jointRetailStatus, registerJointRetail } from "../lib/consensus/retail-joint.ts";

const flags = process.argv.slice(2);
const isPremarket = flags[0] === "--premarket";
if (isPremarket) flags.shift();
const { status, register } = isPremarket ? (await import("../lib/consensus/premarket-study.ts")).premarketStudy :
  { status: jointRetailStatus, register: registerJointRetail };
if (flags.length > 1 || (flags.length && !["--register", "--status", "--advance"].includes(flags[0])))
  throw Error("Usage: consensus:(retail-joint|premarket-study) [--register|--status|--advance]");
const root = fileURLToPath(new URL("../", import.meta.url));
if (!flags.length || flags[0] === "--status") console.log(JSON.stringify(await status(root), null, 2));
else {
  const release = await acquirePublicationLock(root, isPremarket ? "private-prior-premarket" : "private-joint-retail");
  let failure;
  try {
    if (flags[0] === "--register") await register(root);
    console.log(JSON.stringify(await status(root, flags[0] === "--advance"), null, 2));
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(release, failure);
  }
}
