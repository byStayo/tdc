import type { Consensus, FamilyReading, HistoryEntry, Signal, SignalStatus, Snapshot } from "../lib/consensus/types.ts";

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
    '</strong> · ' + percent(view.coverage) + ' observation coverage' + completeness + '</p>' +
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
  return '<details id="' + fragment(s.id) + '"><summary><strong>' + escape(s.title) + '</strong><span>' +
    statusLabel[reading.status] + '</span></summary><div class="body"><p>' + source + ' · ' + s.instruments.map(label).join(", ") +
    '</p><p>' + escape(s.summary) + '</p><p class="muted">Observed ' + observed + release + '</p>' +
    (s.limitation ? '<p>' + escape(s.limitation) + '</p>' : '') +
    (fields ? '<table><thead><tr><th scope="col">Measurement</th><th scope="col">Value</th><th scope="col">Observation</th></tr></thead><tbody>' +
      fields + '</tbody></table>' : '') +
    (series ? '<details class="history"><summary>' + s.series.length + ' dated values · ' + escape(s.unit) + '</summary><pre>' +
      series + '</pre></details>' : '') + '</div></details>';
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
@media(max-width:42rem){.view table thead,section#signals thead{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}
tbody,tr,td,tbody th{display:block}tr{border-bottom:1px solid var(--line);padding:.6rem 0}
tbody th,td{border:0;padding:.15rem 0}td:before{content:attr(data-label) " ";color:var(--muted);font-size:.85rem}
.body{padding-left:.3rem}summary span{display:block;margin-left:1rem}}
@media print{body{background:white}header{padding-top:0}nav{display:none}h2{break-after:avoid}tr{break-inside:avoid}}
`;

/** Portable, script-free chart. The verified edition supplies every displayed measurement and status. */
export function renderConnectionChart(edition: HistoryEntry, snapshot: Snapshot, readings: Reading[], sources: Provider[], views: View[]) {
  const byId = new Map(snapshot.signals.map(s => [s.id, s]));
  const current = readings.filter(s => s.status === "available").length;
  const market = views.find(v => v.instrument === "MARKET" && v.horizon === "daily")!;
  const archive = "https://thedailyconsensus.com/consensus/" + encodeURIComponent(edition.id) + ".json";
  const cards = readings.map(r => signalCard(byId.get(r.id)!, r)).join("");
  const state = new Map(readings.map(r => [r.id, r.status]));
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
    '<p>' + current + ' of ' + readings.length + ' source records were current at the evidence cutoff.</p><p class="muted">Issued ' +
    stamp(edition.issuedAt) + ' · Evidence through ' + stamp(snapshot.cutoff) + '</p><nav aria-label="Report sections"><a href="#views">Forecasts</a>' +
    '<a href="#providers">Providers</a><a href="#signals">Measurements</a><a href="' + archive + '">Original edition</a></nav></header><main>' +
    '<section id="views"><h2>How the inputs voted</h2><p>Each row shows the current inputs in one family and the values that contributed to its score. A zero score is a neutral vote.</p>' +
    views.map(view => viewChart(view, byId, view === market)).join("") + '</section><section id="providers"><h2>Sources named in the edition</h2>' +
    '<p>Status reflects delivery at the issue cutoff. Open a source to trace its inputs.</p><ul class="providers">' + providers +
    '</ul></section><section id="signals"><h2>Measurements and source history</h2>' + cards + '</section></main><footer>' +
    sourceLink(archive, edition.id) + ' · ' + escape(edition.engineVersion) + '</footer></body></html>';
}
