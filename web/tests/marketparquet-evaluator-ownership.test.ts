import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../lib/consensus/history.ts";
import { exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { readReservations, validateActivePromotion } from "../lib/consensus/learning-audit.ts";
import { ETF_SYMBOLS, MARKETPARQUET_SOURCE, marketParquetIssuerFingerprints } from "../lib/consensus/marketparquet.ts";
import { loadEvaluationOutcomes } from "../lib/consensus/outcome-ledger.ts";
import { FIRST_RATE_SOURCE } from "../lib/consensus/firstrate.ts";
import { KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { ENGINE_VERSION, missingSignals } from "../lib/consensus/registry.ts";
import type { Snapshot } from "../lib/consensus/types.ts";
import { createHash } from "node:crypto";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("a bulk backfill cannot create a walk-forward record; fully dated core settlements alone can support matching vendor scores", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-marketparquet-ownership-"));
  try {
    const library = join(root, "lib/consensus"), scripts = join(root, "scripts");
    const archive = join(root, "public/consensus"), vendor = join(root, ".consensus/private-marketparquet");
    await cp(new URL("../lib", import.meta.url), join(root, "lib"), { recursive: true });
    await rm(join(library, "evaluation-state.json"), { force: true });
    await rm(join(library, "performance.json"), { force: true });
    for (const dir of [scripts, archive, vendor, join(root, "bin"), join(vendor, "settlements")])
      await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const name of ["evaluate-marketparquet.ts", "evaluate-consensus.ts"])
      await cp(new URL("../scripts/" + name, import.meta.url), join(scripts, name));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(library, "models.json"), '{"schemaVersion":1,"models":[]}');
    await writeFile(join(archive, "outcomes.json"), "[]");

    // The production reviewed calendar has fewer than 500 sessions. Extend only
    // this isolated synthetic calendar; thresholds and both entry points stay real.
    const calendarPath = join(library, "exchange-calendar.ts");
    await writeFile(calendarPath, (await readFile(calendarPath, "utf8")).replace('from: "2026-01-01"', 'from: "2025-01-01"')
      .replace("export function exchangeSession(", "function uncachedExchangeSession(")
      .replace("export function verifyExpectedSessions(", "function uncachedVerifyExpectedSessions(") + `
        const sessionsCache=new Map(),expectedCache=new Map();
        export function exchangeSession(day:string){if(!sessionsCache.has(day))sessionsCache.set(day,uncachedExchangeSession(day));return sessionsCache.get(day)}
        export function verifyExpectedSessions(days:string[]){const key=JSON.stringify(days);if(!expectedCache.has(key))expectedCache.set(key,uncachedVerifyExpectedSessions(days));return expectedCache.get(key)}
      `);
    const timePath = join(library, "time.ts");
    await writeFile(timePath, (await readFile(timePath, "utf8")).replace("export function localDate(", "function uncachedLocalDate(") + `
      const localDates=new Map();export function localDate(at:string,zone:CalendarZone){const key=zone+at;if(!localDates.has(key))localDates.set(key,uncachedLocalDate(at,zone));return localDates.get(key)}
    `);
    const days2025 = Array.from({ length: 364 }, (_, i) => new Date(Date.UTC(2025, 0, i + 2)).toISOString().slice(0, 10))
      .filter(day => ![0, 6].includes(new Date(day + "T12:00:00Z").getUTCDay()));
    const dates = [...days2025, ...exchangeSessions("2026-01-01", "2027-11-24")];
    const through = dates.at(-1)!, capturedAt = through + "T22:04:00.000Z", reviewedAt = through + "T22:10:00.000Z";
    const snapshots: Snapshot[] = [];
    for (const [i, day] of dates.slice(0, 550).entries()) {
      const at = day + "T12:00:00.000Z", score = i % 2 ? 1 : -1, base = missingSignals(at)[0];
      const snapshot: Snapshot = { schemaVersion: 1, origin: "prospective", engineVersion: ENGINE_VERSION,
        id: at.replace(/[:.]/g, "-"), issuedAt: at, cutoff: at,
        signals: [{ ...base, id: "synthetic-rate", family: "rates", title: "Synthetic fixture",
          status: "available", scores: { daily: score, weekly: null, monthly: null },
          series: [{ date: day, value: score }], source: { ...base.source, url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
            name: "Synthetic fixture", observedAt: day, sha256: hash(day) } }],
        catalysts: [], collectionErrors: [], sourcesAttempted: 1 };
      snapshots.push(snapshot);
      await writeFile(join(archive, snapshot.id + ".json"), JSON.stringify(snapshot));
    }
    await writeFile(join(archive, "index.json"), JSON.stringify(snapshots.map(s =>
      ({ id: s.id, issuedAt: s.issuedAt, engineVersion: s.engineVersion, sha256: digest(s) }))));
    await writeFile(join(library, "current.json"), JSON.stringify(snapshots.at(-1)));
    const bars = dates.map((session, i) => ({ session, sha256: hash(session),
      bars: Object.fromEntries(ETF_SYMBOLS.map(symbol => [symbol, { open: 100, close: i % 2 ? 102 : 98 }])) }));
    const urls = {
      SPY: "https://www.ssga.com/bin/v1/ssmp/fund/dividend-distribution?country=us&language=en&role=intermediary&product=etfs&ticker=SPY",
      DIA: "https://www.ssga.com/bin/v1/ssmp/fund/dividend-distribution?country=us&language=en&role=intermediary&product=etfs&ticker=DIA",
      QQQ: "https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/46090E103/distribution?idType=cusip&productType=ETF",
      IWM: "https://www.ishares.com/us/products/239710/ishare",
      TLT: "https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf?cid=synd",
    };
    const distributions = ETF_SYMBOLS.map(symbol => ({ symbol, source: urls[symbol], responseUrl: urls[symbol],
      capturedAt: through + "T22:03:00.000Z", sha256: hash(symbol), actionsSha256: hash(""), cash: [] }));
    const grant = JSON.stringify({ plan: "full", assets: [{ asset_type: "etf_daily", access: "full" }] });
    const licensedCapture = { entitlement: { source: "https://marketparquet.com/api/v1/assets", document: grant,
      sha256: hash(grant), capturedAt: through + "T22:00:00.000Z" }, downloads: bars.map(file => {
      const bytes = Buffer.alloc(80);
      [...ETF_SYMBOLS].sort().forEach((symbol, i) => {
        bytes.writeDoubleBE(file.bars[symbol].open, 16 * i); bytes.writeDoubleBE(file.bars[symbol].close, 16 * i + 8);
      });
      return { session: file.session, source: "https://marketparquet.com/api/v1/download/etf_daily/" + file.session,
        objectHost: "test.r2.cloudflarestorage.com", size: 23456, sha256: file.sha256,
        authorizationSha256: hash("grant" + file.session), pricesSha256: hash(bytes),
        authorizedAt: through + "T22:01:00.000Z", retrievedAt: through + "T22:02:00.000Z" };
    }) };
    const ledger = { schemaVersion: 1, capturedAt, expectedSessions: dates, bars, distributions, licensedCapture };
    const ledgerText = JSON.stringify(ledger), early = ["2026-11-27", "2026-12-24"];
    const chunks = [];
    for (let start = 0; start < dates.length; start += 100) {
      const part = bars.slice(start, start + 100), csv = part.map(file => file.session.slice(5, 7) + "/" +
        file.session.slice(8) + "/" + file.session.slice(0, 4) + `,100,103,97,${file.bars.SPY.close},1000`).join("\n");
      chunks.push({ from: part[0].session, through: part.at(-1)!.session, capturedAt: reviewedAt,
        hashes: Object.fromEntries(ETF_SYMBOLS.map(s => [s, hash(csv)])), csv: Object.fromEntries(ETF_SYMBOLS.map(s => [s, csv])) });
    }
    const login = "200 OK\nAuthorizations\n=====================\nAll Stocks,1/1/1998,1\n";
    const subscriber = { source: "https://api.kibot.com/?action=login", capturedAt, body: login, sha256: hash(login) };
    const receipt = { schemaVersion: 3, mode: "licensed", through, reconciledAt: reviewedAt,
      ledgerText, ledgerSha256: hash(ledgerText), earlyClosesVerified: early,
      reference: { source: KIBOT_PRICE_CITATION, capturedAt: reviewedAt, chunks, subscriber } };
    await writeFile(join(vendor, "settlements", digest(receipt) + ".json"), JSON.stringify(receipt), { mode: 0o600 });
    await writeFile(join(vendor, "settlement-review.json"), JSON.stringify({ schemaVersion: 1, through, reviewedAt, sha256: digest(receipt) }), { mode: 0o600 });
    const evidence = "reconciliation-2027-11-24T22-10-00-000Z.json";
    await writeFile(join(vendor, evidence), JSON.stringify({ mode: "licensed", passed: true, capturedAfterClose: true,
      reconciledAt: reviewedAt, ledgerSha256: receipt.ledgerSha256,
      verifiedThrough: through, files: bars.map(({ session, sha256 }) => ({ session, sha256 })),
      issuerActions: marketParquetIssuerFingerprints(distributions, dates[0], through), earlyClosesVerified: early }), { mode: 0o600 });
    await writeFile(join(vendor, "licensed-actions-review.json"), JSON.stringify({ through, issuerActionsVerified: true,
      splitBasisVerified: true, earlyClosesVerified: early, evidence, reviewedAt }), { mode: 0o600 });
    await writeFile(join(root, "capture.json"), JSON.stringify({ sessions: bars, distributions, licensedCapture }), { mode: 0o600 });
    await writeFile(join(root, "bin/uv"), '#!/bin/sh\nexec /bin/cat "$(dirname "$0")/../capture.json"\n', { mode: 0o700 });
    let invocation = 0;
    const run = (script: string, ...args: string[]) => {
      const at = new Date(Date.parse("2027-11-25T12:00:00.000Z") + invocation++).toISOString();
      // Reuse real ICU results for repeated identical instants in this large
      // fixture. No calendar validation or entry-point behavior is replaced.
      const clock = `const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[${JSON.stringify(at)}]));}static now(){return D.parse(${JSON.stringify(at)})}};
        const F=Intl.DateTimeFormat,formats=new Map;Intl.DateTimeFormat=new Proxy(F,{construct(T,args){const key=JSON.stringify(args);if(!formats.has(key)){const f=Reflect.construct(T,args),parts=new Map,format=f.formatToParts.bind(f);f.formatToParts=d=>{const k=Number(d);if(!parts.has(k))parts.set(k,format(d));return parts.get(k)};formats.set(key,f)}return formats.get(key)}});
        globalThis.fetch=async()=>{throw Error('Unexpected network request')};`;
      return execFileSync(process.execPath, ["--experimental-strip-types", "--import", "data:text/javascript," + encodeURIComponent(clock),
        "scripts/" + script, ...args], { cwd: root, encoding: "utf8", maxBuffer: 2_000_000, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH,
          MARKETPARQUET_ARCHIVE_LICENSE: "confirmed", MARKETPARQUET_API_KEY: "bt_synthetic_fixture" } });
    };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    const commit = () => { git("add", "."); git("-c", "user.name=Synthetic fixture", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Synthetic checkpoint"); };
    git("init", "--quiet"); commit();
    const staged = JSON.parse(run("evaluate-marketparquet.ts", "--scheduled"));
    assert.equal(staged.trainingPerformed, false);
    assert.deepEqual(await readReservations(root), [], "the vendor stage must leave all new test windows unconsumed");
    assert.equal(staged.cohorts.find((c: { instrument: string; horizon: string }) => c.instrument === "SPY" && c.horizon === "daily").eligibility, "insufficient_data");
    assert.equal(staged.cohorts[0].resolved, 550);
    assert.equal(staged.cohorts[0].holdout, null);
    assert.deepEqual(JSON.parse(await readFile(join(library, "models.json"), "utf8")).models, []);
    assert.ok(!(await readdir(vendor)).some(name => /^validation-/.test(name)));
    // Independent positive fixture: the core saw these synthetic prices six hours after each actual session.
    // Change one source before the original transaction to test attribution even when the two price series are equal.
    await writeFile(join(scripts, "seed-dated-fixture.ts"), `
      import {readFile} from 'node:fs/promises';
      import {outcomeAvailability,PRIVATE_OUTCOME_AVAILABILITY} from '../lib/consensus/outcome-availability.ts';
      import {outcomeIndex,PRIVATE_OUTCOME_LEDGER,PUBLIC_OUTCOME_INDEX} from '../lib/consensus/outcome-ledger.ts';
      import {commitEvaluationTransaction} from '../lib/consensus/evaluation-transaction.ts';
      const {outcomes}=JSON.parse(await readFile('.consensus/private-marketparquet/licensed-evaluation.json','utf8'));
      outcomes.find(row=>row.instrument==='SPY'&&row.horizon==='daily').source=${JSON.stringify(FIRST_RATE_SOURCE)};
      const knownAt=outcomes.map(row=>new Date(Date.parse(row.exitAt)+6*3600000).toISOString());
      await commitEvaluationTransaction('.', [{path:PRIVATE_OUTCOME_LEDGER,value:outcomes},{path:PUBLIC_OUTCOME_INDEX,value:outcomeIndex(outcomes)},
        {path:PRIVATE_OUTCOME_AVAILABILITY,value:outcomeAvailability(outcomes,knownAt)}]);
    `);
    run("seed-dated-fixture.ts");
    run("evaluate-consensus.ts");
    const reservations = await readReservations(root);
    assert.equal(reservations.length, 5);
    assert.ok(reservations.every(r => r.attempt === 1 && r.testIds.length === 110));
    const registry = JSON.parse(await readFile(join(library, "models.json"), "utf8"));
    assert.equal(registry.models.length, 5);
    for (const model of registry.models) validateActivePromotion(model, reservations);
    assert.equal((await loadEvaluationOutcomes(root)).filter(row => row.source !== MARKETPARQUET_SOURCE).length, 1);
    assert.throws(() => run("evaluate-consensus.ts"), /Commit the pending evaluation reservations/);
    commit();
    const before = await Promise.all(reservations.map(r => readFile(join(archive, "evaluations", `${r.instrument}-${r.horizon}-000001.json`), "utf8")));
    const mirrored = JSON.parse(run("evaluate-marketparquet.ts", "--scheduled"));
    assert.equal(mirrored.trainingPerformed, false);
    assert.equal(mirrored.cohorts[0].holdout, null, "a mixed-source SPY score cannot be attributed to this vendor");
    assert.equal(mirrored.cohorts[3].holdout?.testLabels, 110);
    assert.equal(mirrored.cohorts[3].holdout?.passed, true);
    run("evaluate-consensus.ts");
    assert.deepEqual(await readReservations(root), reservations);
    assert.deepEqual(await Promise.all(reservations.map(r => readFile(join(archive, "evaluations", `${r.instrument}-${r.horizon}-000001.json`), "utf8"))), before);
    const report = JSON.parse(await readFile(join(archive, "marketparquet-validation.json"), "utf8"));
    assert.equal(report.cohorts[0].resolved, 550);
    assert.doesNotMatch(JSON.stringify(report), /"(?:bars|outcomes|features|weights|entry|exit|returnPct)"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
