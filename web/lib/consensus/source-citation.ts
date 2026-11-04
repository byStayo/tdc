// Reviewed public citation hosts, including documentation for unavailable feeds.
// A citation allowlist does not grant collection or redistribution rights.
const HOSTS = new Set([
  "data.ecb.europa.eu", "data.sec.gov", "developer.finra.org", "developers.facebook.com", "docs.x.com",
  "fred.stlouisfed.org", "home.treasury.gov", "investor.nvidia.com", "investor.qualcomm.com", "ir.amd.com",
  "polymarket.com", "publicreporting.cftc.gov", "thedailyconsensus.com", "ticdata.treasury.gov",
  "www.apple.com", "www.bankofengland.co.uk", "www.bls.gov", "www.boj.or.jp", "www.ecb.europa.eu",
  "www.federalreserve.gov", "www.gdeltproject.org", "www.microsoft.com", "www.optionseducation.org",
  "www.sec.gov", "www.treasurydirect.gov",
  "openapi.twse.com.tw",
]);

export function validateSourceCitation(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Unsafe public source URL"); }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.port || url.username || url.password ||
      [...url.searchParams.keys()].some(key => /token|api.?key|secret|password|authorization/i.test(key)))
    throw new Error("Unsafe or unreviewed public source URL");
}
