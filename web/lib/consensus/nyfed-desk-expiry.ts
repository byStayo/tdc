export const NYFED_DESK_SURVEY_ID = "nyfed-desk-year-end-policy-expectations";
const easternDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

export function nyFedDeskSurveyTargetExpired(
  signal: { id: string; nyFedDeskSurvey?: { targetDate?: string } },
  cutoff: string,
): boolean {
  if (signal.id !== NYFED_DESK_SURVEY_ID) return false;
  const target = signal.nyFedDeskSurvey?.targetDate;
  const asOf = Date.parse(cutoff);
  return typeof target === "string" && /^\d{4}-12-31$/.test(target) &&
    Number.isFinite(asOf) && easternDay.format(asOf) >= target;
}
