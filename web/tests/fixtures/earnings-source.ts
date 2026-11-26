// Deliberately synthetic source documents for clock, normal-path and protection tests.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { collectIssuerGuidance } from "../../lib/consensus/issuer-guidance-match.ts";
import type { RevenueIssuer } from "../../lib/consensus/issuer-revenue.ts";

export async function earningsSource(root: string, ticker: RevenueIssuer = "AMD", day = "2026-11-30", lateGuidance = false) {
  const nv = ticker === "NVDA", cik = nv ? "0001045810" : "0000002488", year = nv ? 2027 : 2026;
  const end = nv ? "2026-10-25" : "2026-09-26", start = nv ? "2026-07-27" : "2026-06-28";
  const priorEnd = nv ? "July 26, 2026" : "June 27, 2026", actualEnd = nv ? "October 25, 2026" : "September 26, 2026";
  const guidanceDay = nv ? "2026-08-26" : "2026-08-04";
  const accessions = [cik + "-26-000001", cik + "-26-000002", cik + "-26-000003"];
  const quarterDay = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
  const checked = quarterDay + "T12:00:00.000Z";
  const accepted = [guidanceDay + "T20:16:24.000Z", day + "T21:16:27.000Z", quarterDay + "T11:00:00.000Z"];
  const rows = [
    [accessions[0], guidanceDay, guidanceDay, "8-K", "2.02,9.01", accepted[0], guidanceDay + " 16:16:24"],
    [accessions[1], day, day, "8-K", "2.02,9.01", accepted[1], day + " 16:16:27"],
    [accessions[2], quarterDay, end, "10-Q", "", accepted[2], quarterDay + " 06:00:00"],
  ];
  const catalog = "https://data.sec.gov/submissions/CIK" + cik + ".json";
  const folder = (i: number) => "https://www.sec.gov/Archives/edgar/data/" + Number(cik) + "/" + accessions[i].replaceAll("-", "") + "/";
  const documents = new Map<string, string>();
  documents.set(catalog, JSON.stringify({ cik, filings: { recent: Object.fromEntries(
    ["accessionNumber", "filingDate", "reportDate", "form", "items", "acceptanceDateTime"].map((k, i) => [k, rows.map(r => r[i])])) } }));
  function release(q: string, next: string, ended: string, amount: string) {
    const heading = nv ? `NVIDIA Announces Financial Results for ${q} Quarter Fiscal ${year} ended ${ended}` : `AMD Reports ${q} Quarter ${year} Financial Results`;
    const outlook = nv ? `NVIDIA's outlook for the ${next.toLowerCase()} quarter of fiscal ${year} is as follows: • Revenue is expected to be $13.0 billion, plus or minus 2%.` :
      `Current Outlook For the ${next.toLowerCase()} quarter of ${year}, AMD expects revenue to be approximately $13.0 billion, plus or minus $300 million. AMD Teleconference`;
    const statement = nv ? `NVIDIA CORPORATION CONDENSED CONSOLIDATED STATEMENTS OF INCOME (In millions, except per share data) (Unaudited) Three Months Ended ${ended} Revenue $ ${amount} prior` :
      `ADVANCED MICRO DEVICES, INC. CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS (Millions except per share amounts and percentages) (Unaudited) Three Months Ended ${ended} Net revenue $ ${amount} prior`;
    return `<h1>${heading}</h1><p>${outlook}</p><p>${statement}</p>`;
  }
  documents.set(folder(0) + "quarter.htm", release("Second", "Third", priorEnd, "11,000"));
  documents.set(folder(1) + "quarter.htm", release("Third", "Fourth", actualEnd, "13,377"));
  for (const [i, row] of rows.entries()) {
    const document = i === 2 ? "quarter_htm.xml" : "quarter.htm";
    documents.set(folder(i) + accessions[i] + "-index.htm", accessions[i] + ["Filing Date", "Period of Report", "Accepted"].map((s, n) =>
      `<div class="infoHead">${s}</div><div class="info">${[row[1], row[2], row[6]][n]}</div>`).join("") +
      `<tr><td>${i === 2 ? "<b>EXTRACTED</b> XBRL INSTANCE DOCUMENT" : "EX-99.1"}</td><td><a href="${document}">Document</a></td></tr>`);
  }
  const concept = nv ? "Revenues" : "RevenueFromContractWithCustomerExcludingAssessedTax";
  documents.set(folder(2) + "quarter_htm.xml", `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:dei="http://xbrl.sec.gov/dei/2026" xmlns:gaap="http://fasb.org/us-gaap/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217">
    <xbrli:context id="q"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">${cik}</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period></xbrli:context>
    <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
    <dei:EntityCentralIndexKey contextRef="q">${cik}</dei:EntityCentralIndexKey><dei:DocumentType contextRef="q">10-Q</dei:DocumentType><dei:DocumentPeriodEndDate contextRef="q">${end}</dei:DocumentPeriodEndDate>
    <dei:DocumentFiscalYearFocus contextRef="q">${year}</dei:DocumentFiscalYearFocus><dei:DocumentFiscalPeriodFocus contextRef="q">Q3</dei:DocumentFiscalPeriodFocus>
    <gaap:${concept} contextRef="q" unitRef="usd">13377000000</gaap:${concept}></xbrli:xbrl>`);
  const signal = await collectIssuerGuidance(ticker, async url => {
    const text = documents.get(url);
    if (!text) throw Error("Missing synthetic SEC source");
    return { url, text, retrievedAt: !lateGuidance && url.startsWith(folder(0)) ? guidanceDay + "T21:00:00.000Z" : checked,
      sha256: createHash("sha256").update(text).digest("hex") };
  }, () => checked, join(root, ".consensus/private-issuer-revenue"));
  if (!signal.issuerGuidance) throw Error("Synthetic source did not produce a verified comparison: " + signal.summary);
  return signal;
}
