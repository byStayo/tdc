import { premarketStudy } from "./premarket-study.ts";
import { jointRetailStudy } from "./retail-joint.ts";
import { secondaryFamilyStudies } from "./secondary-family-studies.ts";

export const publisherSecondaryStudies = [
  { name: "retail", study: jointRetailStudy },
  { name: "premarket", study: premarketStudy },
  ...secondaryFamilyStudies,
] as const;
