import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { jointRetailStatus, registerJointRetail } from "../lib/consensus/retail-joint.ts";

const flags = process.argv.slice(2);
if (flags.length > 1 || (flags.length && !["--register", "--status", "--advance"].includes(flags[0])))
  throw Error("Usage: consensus:retail-joint [--register|--status|--advance]");
const root = fileURLToPath(new URL("../", import.meta.url));
if (!flags.length || flags[0] === "--status") console.log(JSON.stringify(await jointRetailStatus(root), null, 2));
else {
  const release = await acquirePublicationLock(root, "private-joint-retail");
  let failure;
  try {
    if (flags[0] === "--register") await registerJointRetail(root);
    console.log(JSON.stringify(await jointRetailStatus(root, flags[0] === "--advance"), null, 2));
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(release, failure);
  }
}
