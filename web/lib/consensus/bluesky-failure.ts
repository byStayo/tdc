const descriptions = {
  invalid_arguments: "Invalid bounded sample options or private operation arguments.",
  transport: "The Bluesky stream connection failed.",
  provider_rejected: "The Bluesky stream returned an error frame.",
  connect_timeout: "The Bluesky connection did not open within 15 seconds.",
  cursor_timeout: "The stream did not complete the cursor window within 90 seconds.",
  cursor_window_incomplete: "The stream did not establish both boundaries of the requested cursor window.",
  event_limit: "The collection reached the event cap before it verified the cursor cutoff.",
  byte_limit: "The collection reached the byte cap before it verified the cursor cutoff.",
  stream_inactive: "The stream returned no recent events.",
  stream_schema: "The received stream could not be verified.",
  private_permissions: "Unsafe private storage permissions or ownership.",
  private_storage_invalid: "The private storage path or file size is invalid.",
  invalid_exclusions: "Invalid private exclusions.",
  lock_busy: "The publication lock is busy.",
  lock_unavailable: "The publication lock could not be acquired.",
  lock_cleanup_failed: "The publication lock release could not be verified.",
  operation_failed: "The private operation failed.",
} as const;
export type BlueskyFailureReason = keyof typeof descriptions;

export class BlueskyFailure extends Error {
  readonly reason: BlueskyFailureReason;
  readonly lockReleaseFailed: boolean;
  constructor(reason: BlueskyFailureReason, lockReleaseFailed = false) {
    super(descriptions[reason]);
    this.reason = reason;
    this.lockReleaseFailed = lockReleaseFailed;
  }
}

/** Raw provider, filesystem, exclusion and socket errors may contain private information. */
export function blueskyFailureReport(error: unknown) {
  let reason: BlueskyFailureReason = "operation_failed";
  if (error instanceof BlueskyFailure && Object.hasOwn(descriptions, error.reason)) reason = error.reason;
  else if (error instanceof Error && ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
    reason = "private_permissions";
  }
  const report = { status: "failed", reason, message: descriptions[reason] };
  return error instanceof BlueskyFailure && error.lockReleaseFailed === true ? { ...report, lockReleaseFailed: true } : report;
}
