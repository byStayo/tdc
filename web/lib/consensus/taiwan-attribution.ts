/** OGDL Exhibit attribution, shared by saved provenance and the public display. */
export const TAIWAN_DATA_AGENCY = "Securities and Futures Bureau, Financial Supervisory Commission, Executive Yuan, R.O.C.";
export const TAIWAN_DATASETS: Record<string, string> = {
  "twse-taiex-price": "Weighted Stock Price Index Historical Data",
  "twse-taiex-return": "Weighted Stock Price Return Index",
};
export const TAIWAN_LICENSE_URL = "https://data.gov.tw/license";
export const TAIWAN_OPEN_DATA_NOTICE = "The Open Data is made available to the public under the Open Government Data License, User can make use of it when complying to the condition and obligation of its terms.";
export const TAIWAN_TRANSFORM_NOTICE = "Via the TWSE OpenAPI. Date conversion, charts and changes by The Daily Consensus.";
export function taiwanDataCredit(id: string, year: string): string {
  if (!TAIWAN_DATASETS[id] || !/^\d{4}$/.test(year)) throw new Error("Invalid Taiwan attribution identity");
  return `${TAIWAN_DATA_AGENCY} ${year} ${TAIWAN_DATASETS[id]} (dataset version not stated).`;
}
export function taiwanAttribution(id: string, year: string): string {
  return `${taiwanDataCredit(id, year)} ${TAIWAN_OPEN_DATA_NOTICE} Open Government Data License 1.0: ${TAIWAN_LICENSE_URL}. ${TAIWAN_TRANSFORM_NOTICE}`;
}
