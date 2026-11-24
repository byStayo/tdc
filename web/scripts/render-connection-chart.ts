import { RANGE_POLICY, sessionRangeSource } from "../lib/consensus/regular-session-range.ts";
import type { Consensus, FamilyReading, HistoryEntry, Signal, SignalStatus, Snapshot } from "../lib/consensus/types.ts";
import type { connectionProductStatus } from "./connection-product-status.ts";

type Product = Awaited<ReturnType<typeof connectionProductStatus>>;

type View = Omit<Consensus, "families"> & {
  families: (FamilyReading & { contributors: { signal: string; score: number }[] })[];
};
type Reading = Pick<Signal, "id" | "status"> & { providerLabel: string | null };
type Provider = { label: string; signals: string[] };
const statusLabel: Record<SignalStatus, string> = {
  available: "Current", stale: "Stale", unavailable: "Unavailable", not_formed: "Awaiting confirmation",
};
const escape = (value: string | number) => String(value).replace(/[&<>"']/g,
  char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const percent = (fraction: number) => (fraction * 100).toFixed(1).replace(/\.0$/, "") + "%";
const score = (value: number) => Number(value.toFixed(6)).toString();
const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", dateStyle: "medium", timeStyle: "long",
});
const stamp = (iso: string) => '<time datetime="' + escape(iso) + '">' + escape(dateFormat.format(Date.parse(iso))) + '</time>';
const label = (name: string) => name === "MARKET" ? "Market" : name;
const voteCount = (view: View) => view.families.filter(family => family.score !== null).length;
const fragment = (id: string) => "signal-" + encodeURIComponent(id);
function sourceLink(raw: string, title: string) {
  try {
    const url = new URL(raw);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
      return '<a href="' + escape(url.href) + '" rel="noreferrer">' + escape(title) + '</a>';
  } catch { /* Some historical sources have no URL. */ }
  return escape(title);
}

function viewChart(view: View, byId: Map<string, Signal>, first: boolean) {
  const completeness = view.directionalCoverage === undefined ? "" : " · " + percent(view.directionalCoverage) + " directional coverage";
  const families = view.families.map(family => {
    const count = family.available + "/" + family.expected;
    const contributors = family.contributors.map(c =>
      '<a href="#' + fragment(c.signal) + '">' + escape(byId.get(c.signal)!.title) + '</a> (' + score(c.score) + ')').join(" · ");
    return '<tr><th scope="row">' + escape(family.label) + '</th><td data-label="Observations"><meter min="0" max="' +
      family.expected + '" value="' + family.available + '" aria-label="' + escape(family.label + " current observations") + '"></meter> ' +
      count + '</td><td data-label="Family score">' + (family.score === null ? "No vote" : score(family.score)) +
      '</td><td data-label="Voting inputs">' + (contributors || "—") + '</td></tr>';
  }).join("");
  const reasons = view.reasons.map(reason => '<li>' + escape(reason) + '</li>').join("");
  return '<details class="view" id="' + view.instrument + '-' + view.horizon + '"' + (first ? ' open' : '') +
    '><summary><strong>' + label(view.instrument) + ' · ' + view.horizon + '</strong><span>' + voteCount(view) +
    '/' + view.families.length + ' voting families</span></summary><div class="body"><p><strong>' + escape(view.label) +
    '</strong> · ' + percent(view.coverage) + ' observation coverage' + completeness + '</p><p>Combined score ' +
    (view.score === null ? "unavailable" : score(view.score)) + ' · ' + view.bullish + ' bullish · ' + view.bearish +
    ' bearish · ' + view.neutral + ' neutral.</p>' +
    (reasons ? '<ul>' + reasons + '</ul>' : '') + '<table><thead><tr><th scope="col">Family</th><th scope="col">Current inputs</th>' +
    '<th scope="col">Score</th><th scope="col">Voting inputs</th></tr></thead><tbody>' + families + '</tbody></table></div></details>';
}

function signalCard(s: Signal, reading: Reading) {
  const fields = s.metrics.map(metric => '<tr><th scope="row">' + escape(metric.label) + '</th><td data-label="Value">' +
    escape(metric.value) + ' ' + escape(metric.unit) + '</td><td data-label="Observation">' + escape(metric.date) + '</td></tr>').join("");
  const series = s.series.map(p => escape(p.date) + '   ' + escape(p.value)).join("\n");
  const observed = s.source.observedAt ? escape(s.source.observedAt) : "Unavailable";
  const release = s.source.releasedAt ? ' · Released ' + escape(s.source.releasedAt) : "";
  const source = reading.providerLabel ? sourceLink(s.source.url, reading.providerLabel) : "No connected source";
  const peers = s.etfFlowPeers;
  const peerReading = peers ? '<p>Other ' + (peers.category === "Stocks" ? "stock" : "bond") + ' ETFs · ' +
    peers.creations + ' with inflows, ' + peers.redemptions + ' with outflows, ' + peers.flat + ' flat. ' +
    sourceLink(peers.url, "ETFIQ fund history") + '</p>' : '';
  return '<details id="' + fragment(s.id) + '"><summary><strong>' + escape(s.title) + '</strong><span>' +
    statusLabel[reading.status] + '</span></summary><div class="body"><p>' + source + ' · ' + s.instruments.map(label).join(", ") +
    '</p><p>' + escape(s.summary) + '</p><p class="muted">Observed ' + observed + release + '</p>' +
    (s.source.attribution ? '<p>' + escape(s.source.attribution) + '</p>' : '') +
    peerReading + (s.limitation ? '<p>' + escape(s.limitation) + '</p>' : '') +
    (fields ? '<table><thead><tr><th scope="col">Measurement</th><th scope="col">Value</th><th scope="col">Observation</th></tr></thead><tbody>' +
      fields + '</tbody></table>' : '') +
    (series ? '<details class="history"><summary>' + s.series.length + ' dated values · ' + escape(s.unit) + '</summary><pre>' +
      series + '</pre></details>' : '') + '</div></details>';
}

function editionContext(snapshot: Snapshot) {
  const blocks: string[] = [];
  const ranges = snapshot.regularSessionRanges;
  if (ranges) {
    const bands = ["Lowest fifth", "Second fifth", "Middle fifth", "Fourth fifth", "Highest fifth"];
    const items = ranges.rows.map(row => {
      const source = sessionRangeSource(row);
      return '<li><strong>' + escape(row.fund) + '</strong> · ' + bands[row.closeFifth - 1] +
        ' on ' + escape(row.session) + ' · verified ' + stamp(row.verifiedAt) +
        (row.source ? ' · ' + sourceLink(source.url, source.name) : '') + '</li>';
    }).join("");
    const credit = ranges.method === RANGE_POLICY ? sourceLink(ranges.url, ranges.attribution) :
      "Regular-session calculations by The Daily Consensus.";
    blocks.push('<details open><summary><strong>Where each fund closed within its regular-session range</strong></summary>' +
      '<div class="body"><p>Each fifth spans 20% of the distance from the day’s low to its high. These positions supply daily price context.</p>' +
      '<ul>' + items + '</ul><p>' + credit + '</p></div></details>');
  }
  const options = snapshot.optionActivity;
  if (options) {
    const items = options.rows.map(row => '<li><strong>' + escape(row.symbol) + '</strong> · ' + (row.status === "observed"
      ? row.putPercent + '% puts by traded contract volume' : row.status === "unlisted" ? "No matching listed pair" : "Unavailable") + '</li>').join("");
    blocks.push('<details><summary><strong>Options volume by fund</strong></summary><div class="body"><p>One matched put and call at the same strike per fund. Session ' +
      escape(options.session) + ' · Expiry ' + escape(options.expiry) + '.</p><ul>' + items + '</ul><p>' +
      sourceLink(options.source, "Market History · OPRA volume") + '</p></div></details>');
  }
  if (snapshot.holdings?.length) {
    const items = snapshot.holdings.flatMap(filer => [filer.current, filer.previous].map(filing =>
      '<li>' + sourceLink(filing.url, filer.name + " · " + filing.period) + ' · ' + escape(filing.rowCount) + ' filing rows · filed ' +
      escape(filing.filedAt) + '</li>')).join("");
    blocks.push('<details><summary><strong>Institutional holdings</strong></summary><div class="body"><ul>' + items + '</ul></div></details>');
  }
  if (snapshot.catalysts?.length) {
    const items = snapshot.catalysts.map(event => '<li>' + escape(event.at) + ' · ' + sourceLink(event.url, event.title) +
      ' · ' + escape(event.source) + '</li>').join("");
    blocks.push('<details><summary><strong>Release and event calendar</strong><span>' + snapshot.catalysts.length +
      ' entries</span></summary><div class="body"><ul>' + items + '</ul></div></details>');
  }
  const news = snapshot.news;
  if (news) {
    const items = news.stories.map(story => '<li>' + sourceLink(story.url, story.title) + ' · ' + escape(story.domain) + '</li>').join("");
    blocks.push('<details><summary><strong>News coverage</strong><span>' + news.storyCount + ' stories across ' + news.publishers +
      ' publishers</span></summary><div class="body"><p>Source batch ' + stamp(news.batchAt) + ' · ' + news.rowsScanned +
      ' records scanned.</p><ul>' + items + '</ul><p>' + sourceLink(news.sourceUrl, "GDELT source batch") + '</p></div></details>');
  }
  return blocks.length ? '<section id="context"><h2>Other evidence in this edition</h2>' + blocks.join("") + '</section>' : "";
}

const styles = `
:root{color-scheme:light;--ink:#16243c;--muted:#465872;--line:#c6cfda;--accent:#174d83;--paper:#f8f9f8}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:1rem/1.55 system-ui,sans-serif}
main,header,footer{max-width:72rem;margin:auto;padding:1.5rem clamp(1rem,4vw,3rem)}
header{border-bottom:2px solid var(--ink);padding-top:3rem}
h1,h2{font-family:Georgia,serif;font-weight:500;line-height:1.15;text-wrap:balance}h1{font-size:clamp(2rem,5vw,3.4rem);margin:.3rem 0}
h2{font-size:1.8rem;margin:0 0 1rem}section{margin:2rem 0 3rem}p{max-width:76ch;margin:.6rem 0}
nav{display:flex;gap:1.2rem;flex-wrap:wrap;margin-top:1rem}a{color:var(--accent);text-underline-offset:.2em}
a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.muted,summary span{color:var(--muted)}details{border-top:1px solid var(--line);overflow-wrap:anywhere}
summary{cursor:pointer;padding:.8rem .2rem}summary strong{margin-right:.8rem}.body{padding:0 .2rem 1rem}
table{width:100%;border-collapse:collapse;text-align:left;margin:1rem 0}th,td{padding:.5rem;vertical-align:top;border-bottom:1px solid var(--line)}
th{font-weight:600}td,pre,summary span{font-variant-numeric:tabular-nums}.view td:nth-child(2){white-space:nowrap}
meter{height:1rem;width:4.5rem;accent-color:var(--accent)}.history{margin-top:1rem}.history pre{max-height:17rem;overflow:auto}
ul{padding-inline-start:1.4rem}.providers{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(19rem,100%),1fr));gap:.6rem 1rem;padding:0}
.providers details{border:1px solid var(--line);padding:0 .7rem}.providers ul{margin:0 0 1rem}
@media(max-width:42rem){.view table thead,section#signals thead,section#product thead{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}
tbody,tr,td,tbody th{display:block}tr{border-bottom:1px solid var(--line);padding:.6rem 0}
tbody th,td{border:0;padding:.15rem 0}td:before{content:attr(data-label) " ";color:var(--muted);font-size:.85rem}
.body{padding-left:.3rem}summary span{display:block;margin-left:1rem}}
@media print{body{background:white}header{padding-top:0}nav{display:none}h2{break-after:avoid}tr{break-inside:avoid}}
`;

function currentProduct(product: Product, snapshot: Snapshot, readings: Reading[], views: View[], sources: Provider[]) {
  const market = views.find(v => v.instrument === "MARKET" && v.horizon === "daily")!;
  const active = readings.filter(r => r.status === "available");
  const social = active.filter(r => r.id === "social-x" || r.id === "social-instagram").length;
  const news = snapshot.news;
  const options = snapshot.optionActivity?.rows ?? [];
  const features = [
    ["Weekday publication", "Latest archived issue " + snapshot.issuedAt + ". The public health endpoint reports delivery."],
    ["Market and ETF reports", product.editorial.current + " of " + product.editorial.checked + " published briefs were current at evaluation."],
    ["Consensus", views.length + " fund and horizon combinations. " + voteCount(market) + " families voted on the market daily view."],
    ["Evidence panels", sources.length + " named source labels, " + readings.length + " signal records and " + product.measurements + " measurements."],
    ["News and catalysts", (news ? news.storyCount + " stories from " + news.publishers + " publishers" : "No news batch") + " and " + snapshot.catalysts.length + " calendar entries."],
    ["Holdings, orders and flows", (snapshot.holdings?.length ?? 0) + " holdings disclosures and " + active.filter(r => r.id.startsWith("etfiq-")).length + " current ETFIQ readings."],
    ["Historical model research", product.historicalStudies + " published historical comparisons with their held-out results."],
    ["Edition history", product.editions + " archived forecasts remain available as issued."],
    ["Settlement and replay", product.settledRecords + " settled archive records. Selecting the last forecast before entry gives " + product.selected + " outcomes for the current engine."],
    ["Social and newsletters", social + " of the two X and Instagram signal feeds supplied a current observation. Private reading lists and expired social samples supply no public vote."],
    ["ETF price and dividend checks", "Two historical price series and issuer distributions checked for all five funds. The table below shows the separate prospective gaps."],
    ["Prospective model validation", product.activeModels + " active models across " + product.candidates + " candidates. " + product.calls + " calls and " + product.abstentions + " abstentions in the selected outcomes."],
    ["Issuer releases", active.filter(r => r.id.startsWith("sec-issuer-guidance-")).length + " current SEC issuer guidance readings."],
    ["Editorial collection", product.editorial.citedSources + " distinct source URLs cited across the published market and fund briefs."],
    ["Listed options volume", options.filter(r => r.status === "observed").length + " of " + options.length + " tracked options rows supplied observed contract volume."],
  ];
  const grid = features.map(([name, result]) => '<tr><th scope="row">' + escape(name) + '</th><td data-label="Status">' +
    escape(result) + '</td></tr>').join("");
  const prices = product.price.funds.map(row => {
    const due = product.priceDueByInstrument[row.symbol];
    const values: [string, string | number][] = [["Daily", row.daily.passed + "/" + row.daily.checked],
      ["5-session", row.weekly.passed + "/" + row.weekly.checked], ["21-session", row.monthly.passed + "/" + row.monthly.checked],
      ["Dividends", row.dividends.passed + "/" + row.dividends.checked], ["Elapsed forecasts awaiting prices", due.daily + due.weekly + due.monthly]];
    return '<tr><th scope="row">' + row.symbol + '</th>' + values.map(([key, value]) =>
      '<td data-label="' + key + '">' + escape(value) + '</td>').join("") + '</tr>';
  }).join("");
  const forward = market.families.filter(family => product.forwardFamilies.some(id => id === family.id)).map(family => family.label);
  return '<section id="product"><h2>Features and operating status</h2><p>Issue inputs are dated at the cutoff. The model and settlement report was evaluated ' +
    stamp(product.asOf) + '.</p><table><thead><tr><th scope="col">Feature</th><th scope="col">Verified in the release</th></tr></thead><tbody>' + grid +
    '</tbody></table><h3>ETF price checks and outstanding outcomes</h3><p>The first four columns count passed checks across August 31 to October 1, 2026, before launch. The last column counts outstanding prices for real, elapsed forecasts.</p>' +
    '<table><thead><tr><th scope="col">ETF</th><th scope="col">Daily</th><th scope="col">5-session</th><th scope="col">21-session</th><th scope="col">Dividends</th><th scope="col">Elapsed forecasts awaiting prices</th></tr></thead><tbody>' +
    prices + '</tbody></table><p>' + product.completeDailyCohorts + ' input-eligible daily sessions have settled for all five ETFs. Across the archive, ' +
    product.due + ' elapsed targets await prices and ' + product.future + ' have future exits. ' + product.calendarMissing + ' await calendar coverage and ' +
    product.unaccounted + ' are unaccounted for.</p><p>The weekday publisher attaches witnessed inputs to future ETF outcomes for ' +
    escape(forward.join(", ")) + '. Each comparison applies to its registered funds.</p></section>';
}

/** Archive views use only their original evidence. The optional current product inventory has a separate evaluation clock. */
export function renderConnectionChart(edition: HistoryEntry, snapshot: Snapshot, readings: Reading[], sources: Provider[], views: View[], product?: Product) {
  const byId = new Map(snapshot.signals.map(s => [s.id, s]));
  const current = readings.filter(s => s.status === "available").length;
  const market = views.find(v => v.instrument === "MARKET" && v.horizon === "daily")!;
  const archive = "https://thedailyconsensus.com/consensus/" + encodeURIComponent(edition.id) + ".json";
  const cards = readings.map(r => signalCard(byId.get(r.id)!, r)).join("");
  const context = editionContext(snapshot);
  const state = new Map(readings.map(r => [r.id, r.status]));
  const delivering = sources.filter(p => p.signals.some(id => state.get(id) === "available")).length;
  const countStatus = (status: SignalStatus) => readings.filter(r => r.status === status).length;
  const providers = sources.map(p => {
    const active = p.signals.filter(id => state.get(id) === "available").length;
    const links = p.signals.map(id => '<li><a href="#' + fragment(id) + '">' + escape(byId.get(id)!.title) +
      '</a> · ' + statusLabel[state.get(id)!] + '</li>').join("");
    return '<li><details><summary><strong>' + escape(p.label) + '</strong><span>' + active + '/' + p.signals.length +
      ' current</span></summary><ul>' + links + '</ul></details></li>';
  }).join("");
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Connection report · The Daily Consensus</title><style>' + styles + '</style></head><body><header><a href="#views">The Daily Consensus</a>' +
    '<h1>' + voteCount(market) + ' of ' + market.families.length + ' families vote on the daily market outlook</h1>' +
    '<p>' + current + ' of ' + readings.length + ' source records were current at the evidence cutoff. ' + delivering + ' of ' +
    sources.length + ' named source labels supplied a current reading.</p><p>' + countStatus("stale") + ' readings were stale, ' +
    countStatus("unavailable") + ' unavailable and ' + countStatus("not_formed") + ' awaiting confirmation.</p><p class="muted">Issued ' +
    stamp(edition.issuedAt) + ' · Evidence through ' + stamp(snapshot.cutoff) + '</p><nav aria-label="Report sections"><a href="#views">Forecasts</a>' +
    (product ? '<a href="#product">Product status</a>' : '') + '<a href="#providers">Providers</a><a href="#signals">Measurements</a>' + (context ? '<a href="#context">Other evidence</a>' : '') +
    '<a href="' + archive + '">Original edition</a></nav></header><main>' +
    (product ? currentProduct(product, snapshot, readings, views, sources) : '') +
    '<section id="views"><h2>How the inputs voted</h2><p>Each row shows the current inputs in one family and the values that contributed to its score. A zero score is a neutral vote.</p>' +
    (market.directionalCoverage === undefined ? '' : '<p>For each instrument and horizon the rules average the eligible input scores within each family, then average the voting families using their weights. Observation coverage averages the share of current inputs in each family. The reasons below explain any withheld call.</p>') +
    views.map(view => viewChart(view, byId, view === market)).join("") + '</section>' + context + '<section id="providers"><h2>Sources named by signal records</h2>' +
    '<p>Status reflects delivery at the issue cutoff. Open a source to trace its inputs.</p><ul class="providers">' + providers +
    '</ul></section><section id="signals"><h2>Measurements and source history</h2>' + cards + '</section></main><footer>' +
    sourceLink(archive, edition.id) + ' · ' + escape(edition.engineVersion) + ' · ' +
    sourceLink("https://thedailyconsensus.com/consensus/ATTRIBUTION.txt", "Source credits and licences") + '</footer></body></html>';
}
