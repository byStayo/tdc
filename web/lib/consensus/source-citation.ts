// Reviewed public citation hosts, including documentation for unavailable feeds.
// A citation allowlist does not grant collection or redistribution rights.
const HOSTS = new Set([
  "data.ecb.europa.eu", "data.sec.gov", "developer.finra.org", "developers.facebook.com", "docs.x.com", "firstratedata.com",
  "fred.stlouisfed.org", "getmarkethistory.com", "home.treasury.gov", "investor.nvidia.com", "investor.qualcomm.com", "ir.amd.com",
  "polymarket.com", "publicreporting.cftc.gov", "thedailyconsensus.com", "ticdata.treasury.gov",
  "www.apple.com", "www.bankofcanada.ca", "www.bankofengland.co.uk", "www.bls.gov", "www.boj.or.jp", "www.ecb.europa.eu",
  "www.federalreserve.gov", "www.gdeltproject.org", "www.microsoft.com", "www.optionseducation.org",
  "www.mof.go.jp", "www.newyorkfed.org", "www.oregon.gov", "www.census.gov", "www.bea.gov",
  "www.sec.gov", "www.treasurydirect.gov", "www.ons.gov.uk",
  "data.gov.tw", "etfiq.com", "openapi.twse.com.tw", "www.quantisnow.com",
]);

export function validateSourceCitation(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Unsafe public source URL"); }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.port || url.username || url.password ||
      (url.hostname === "data.gov.tw" && !/^https:\/\/data\.gov\.tw\/dataset\/(11555|11761)$/.test(url.href)) ||
      [...url.searchParams.keys()].some(key => /token|api.?key|secret|password|authorization/i.test(key)))
    throw new Error("Unsafe or unreviewed public source URL");
}
