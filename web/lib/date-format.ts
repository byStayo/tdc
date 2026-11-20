/** Publication clocks use New York time on both server and client; date-only observations use UTC. */
export function dateLabel(
  value: string | null | undefined,
  short = false,
): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(short ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(date);
}

export function timestamp(value: string | null | undefined): string {
  if (!value) return "Time unavailable";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateLabel(value);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: "America/New_York",
  }).format(date);
}

export function localDateLabel(value: string | null | undefined): string {
  if (!value) return "Date unavailable";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateLabel(value);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(date);
}

