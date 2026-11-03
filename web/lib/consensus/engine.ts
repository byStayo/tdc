/** The current engine is the canonical versioned implementation.
 * Methodology changes require a new frozen module and an explicit version bump. */
export { calculateConsensus, effectiveStatus, clamp } from "./engines/v2.ts";
