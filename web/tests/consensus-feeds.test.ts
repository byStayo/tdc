import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import {
  fomcEvents,
  treasuryEvents,
  expirationEvents,
  collectMarketCalendars,
} from "../lib/consensus/calendars.ts";
import { eventUpcoming } from "../lib/consensus/time.ts";
import {
  parseGkg,
  gdeltManifest,
  unpackGkg,
  gdeltTime,
  collectNews,
} from "../lib/consensus/news.ts";

const cutoff = "2026-11-03T06:00:00.000Z";
test("official calendars preserve date-only events and holiday-adjusted expiries", () => {
  const html =
    '<h4>2026 FOMC Meetings</h4><div class="fomc-meeting__month"><strong>December</strong></div><div class="fomc-meeting__date">8-9*</div><h4>2025 FOMC Meetings</h4><div class="fomc-meeting__month"><strong>December</strong></div><div class="fomc-meeting__date">9-10*</div>';
  const fed = fomcEvents(html, cutoff);
  assert.equal(fed.length, 1);
  assert.equal(fed[0].at, "2026-12-09");
  const expiry = expirationEvents(
    {
      legend: [
        {
          type: "monthly",
          title:
            "Monthly equity, index, and cash-settled currency options expiration date",
        },
      ],
      data: [{ date: "2026-06-18T00:00:00", events: [{ type: "monthly" }] }],
    },
    "2026-06-01T06:00:00.000Z",
  );
  assert.equal(expiry[0].at, "2026-06-18");
  assert.equal(expiry[0].kind, "expiry");
  assert.ok(eventUpcoming("2026-11-03", "2026-11-04T04:30:00.000Z"));
  assert.ok(!eventUpcoming("2026-11-03", "2026-11-04T05:01:00.000Z"));
});
test("Treasury auctions require announced evidence and convert Eastern deadline without inventing times", () => {
  const row = {
    cusip: "912797VH7",
    securityType: "Bill",
    securityTerm: "6-Week",
    competitiveAuctionCloseDate: "2026-11-03T00:00:00",
    competitiveAuctionCloseTime: "11:30 AM",
    announcementDate: "2026-10-29T00:00:00",
    offeringAmount: "100000000000",
  };
  const events = treasuryEvents(
    [
      row,
      { ...row, cusip: "912797VH8", announcementDate: "2026-11-04T00:00:00" },
      { ...row, cusip: "912797VH9", competitiveAuctionCloseTime: "" },
    ],
    cutoff,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].at, "2026-11-03T16:30:00.000Z");
  assert.match(events[0].title, /\$100bn/);
});
test("failed calendar sources stay unavailable without directional scores", async () => {
  const r = await collectMarketCalendars(async () => {
    throw new Error("offline");
  });
  assert.equal(r.catalysts.length, 0);
  assert.equal(r.signals.length, 6);
  assert.ok(
    r.signals.every(
      (x) =>
        x.status === "unavailable" &&
        Object.values(x.scores).every((v) => v === null),
    ),
  );
});
const batch = "2026-11-03T05:45:00.000Z",
  source = "https://data.gdeltproject.org/gdeltv2/20261103054500.gkg.csv.zip";
function gkg(
  url: string,
  title: string,
  tone = "2,3,1,4,10,0,300",
  published = "20261103050000",
  theme = "ECON_STOCKMARKET",
) {
  const cols = Array<string>(27).fill("");
  cols[0] = "20261103054500-1";
  cols[1] = "20261103054500";
  cols[2] = "1";
  cols[3] = "news.example";
  cols[4] = url;
  cols[7] = theme + ";";
  cols[15] = tone;
  cols[26] = `<PAGE_TITLE>${title}</PAGE_TITLE><PAGE_PRECISEPUBTIMESTAMP>${published}</PAGE_PRECISEPUBTIMESTAMP>`;
  return cols.join("\t");
}
test("news filters false topics, future/old articles, invalid tone and unsafe links; collapses syndication", () => {
  const lines = [
    gkg("https://a.example/a", "Stocks rise as earnings grow"),
    gkg("https://b.example/a", "Stocks rise as earnings grow"),
    gkg("https://a.example/a?utm_campaign=x", "Stocks rise as earnings grow"),
    gkg("https://b.example/b", "Bond yields fall", "-2,1,3,4,10,0,500"),
    gkg("https://c.example/c", "Local wildlife returns"),
    gkg(
      "https://c.example/d",
      "Stocks tomorrow",
      "2,3,1,4,10,0,300",
      "20261104050000",
    ),
    gkg(
      "https://c.example/e",
      "Old stock earnings",
      "2,3,1,4,10,0,300",
      "20261001050000",
    ),
    gkg("javascript:alert(1)", "Stocks unsafe"),
    gkg("https://c.example/f", "Stocks missing tone", ",3,1,4,10,0,300"),
  ];
  const p = parseGkg(lines.join("\n"), batch, source, "a".repeat(64), cutoff);
  assert.equal(p.matchedArticles, 3);
  assert.equal(p.storyCount, 2);
  assert.equal(p.positive, 1);
  assert.equal(p.negative, 1);
  assert.equal(p.balanced, 0);
  assert.equal(p.meanTone, 0);
  assert.equal(
    p.stories.reduce((n, s) => n + s.mentions, 0),
    3,
  );
  assert.throws(
    () =>
      parseGkg(
        lines[0],
        "2026-11-04T05:45:00.000Z",
        source,
        "a".repeat(64),
        cutoff,
      ),
    /future/,
  );
});
test("news manifest and ZIP enforce source, freshness, checksum shape and extraction limits", () => {
  const line = `123 ${"a".repeat(32)} http://data.gdeltproject.org/gdeltv2/20261103054500.gkg.csv.zip`;
  assert.equal(gdeltManifest(line, cutoff).url, source);
  assert.throws(() =>
    gdeltManifest(
      line.replace("data.gdeltproject.org", "evil.example"),
      cutoff,
    ),
  );
  assert.throws(() =>
    gdeltManifest(line.replace("20261103054500", "20261104054500"), cutoff),
  );
  assert.equal(gdeltTime("20260230054500"), null);
  const name = "20261103054500.gkg.csv";
  assert.equal(
    unpackGkg(zipSync({ [name]: strToU8("sample") }), name),
    "sample",
  );
  assert.throws(() =>
    unpackGkg(zipSync({ "../bad": strToU8("sample") }), name),
  );
});
test("news outage never becomes neutral sentiment", async () => {
  const result = await collectNews(
    async () => new Response("rate limited", { status: 429 }),
  );
  assert.equal(result.pulse, null);
  assert.equal(result.signal.status, "unavailable");
  assert.ok(Object.values(result.signal.scores).every((s) => s === null));
});
