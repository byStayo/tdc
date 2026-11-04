"use client";

import { useMemo, useState } from "react";
import { ChevronRight, FileText, Search } from "lucide-react";
import type { Envelope, Filing, Positioning } from "@/lib/contracts";
import TradingViewWidget, { usesBroadMarketNews } from "./TradingViewWidget";
import {
  dateLabel,
  EmptyState,
  ExternalLink,
  Notice,
  number,
  PanelHeader,
  SourceNote,
  StatusBadge,
} from "./ui";

const issuerNames: Record<string, string> = { "320193": "Apple Inc.", "789019": "Microsoft Corp.", "2488": "Advanced Micro Devices, Inc.", "1045810": "NVIDIA Corp." };
function positioningCategories(item: Positioning) {
  return [
    { name: "Asset managers", long: item.assetManagerLong, short: item.assetManagerShort },
    { name: "Leveraged funds", long: item.leveragedLong, short: item.leveragedShort },
    { name: "Dealers / intermediaries", long: item.dealerLong, short: item.dealerShort },
  ].map(category => ({ ...category, net: category.long !== null && category.short !== null ? category.long - category.short : null }));
}

export function FilingsPanel({
  filings,
  loading,
  compact = false,
  onViewAll,
}: {
  filings?: Envelope<Filing[]>;
  loading: boolean;
  compact?: boolean;
  onViewAll?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [form, setForm] = useState("all");
  const forms = [
    ...new Set(filings?.data.map((item) => item.form) ?? []),
  ].sort();
  const entries = useMemo(
    () =>
      (filings?.data ?? []).filter(
        (item) =>
          (form === "all" || item.form === form) &&
          `${item.company} ${item.form} ${item.description}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [filings, query, form],
  );
  const shown = compact ? entries.slice(0, 3) : entries;
  return (
    <section className="panel filings-panel">
      <PanelHeader eyebrow="PRIMARY SOURCES" title="From the official record">
        {compact && onViewAll ? (
          <button className="text-button" onClick={onViewAll}>
            All filings
            <ChevronRight size={14} />
          </button>
        ) : (
          <StatusBadge status={filings?.status} />
        )}
      </PanelHeader>
      <p className="panel-intro">
        Company disclosures, directly from SEC EDGAR. Read the original document
        alongside the reporting period.
      </p>
      {!compact && (
        <div className="panel-toolbar">
          <label className="field-search">
            <Search size={15} />
            <span className="sr-only">Filter SEC filings</span>
            <input
              placeholder="Filter companies or disclosures"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="select-field">
            <span className="sr-only">Filing form</span>
            <select
              value={form}
              onChange={(event) => setForm(event.target.value)}
            >
              <option value="all">All forms</option>
              {forms.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {shown.length ? (
        <div className="filings-list">
          {shown.map((filing) => (
            <article className="filing-item" key={filing.id}>
              <span className="filing-form">
                <FileText size={15} />
                {filing.form}
              </span>
              <div className="filing-body">
                <h3>
                  <ExternalLink href={filing.url} title={filing.company}>
                    {issuerNames[String(Number(filing.cik))] ?? filing.company}
                  </ExternalLink>
                </h3>
                <p>{filing.description || `${filing.form} filing`}</p>
                <div className="filing-dates">
                  <span>Filed {dateLabel(filing.filedAt)}</span>
                  {filing.reportDate && (
                    <span>Reporting period {dateLabel(filing.reportDate)}</span>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            loading
              ? "Loading official filings"
              : query || form !== "all"
                ? "No matching filings"
                : "No filings available"
          }
          loading={loading}
        >
          {query || form !== "all"
            ? "Try another company, form or keyword."
            : (filings?.message ??
              "No verified filing documents have been returned for this view.")}
        </EmptyState>
      )}
      <SourceNote envelope={filings} />
      {!compact && (
        <Notice>
          Filing dates and reporting periods are different. Holdings disclosures
          describe reported historical positions; they do not reveal a manager’s
          current portfolio or trading intent.
        </Notice>
      )}
    </section>
  );
}

export function PositioningPanel({
  positioning,
  loading,
}: {
  positioning?: Envelope<Positioning[]>;
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  const rows = (positioning?.data ?? []).filter((item) =>
    `${item.market} ${item.contractCode}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section className="panel positioning-panel">
      <PanelHeader
        eyebrow="CFTC · TRADERS IN FINANCIAL FUTURES"
        title="Positioning, in context"
      >
        <StatusBadge status={positioning?.status} />
      </PanelHeader>
      <p className="panel-intro">
        Reported futures positions by participant category. These are aggregate
        observations, not individual investor identities or real-time activity.
      </p>
      <div className="panel-toolbar">
        <label className="field-search">
          <Search size={15} />
          <span className="sr-only">Filter futures markets</span>
          <input
            placeholder="Find a market or contract code"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {rows.length ? (
        <div className="positioning-list">
          {rows.map((item) => (
            <article className="positioning-card" key={item.id}>
              <div className="positioning-heading">
                <div>
                  <h3>{item.market}</h3>
                  <p>
                    Report date · {dateLabel(item.reportDate)}
                    <span>Contract {item.contractCode}</span>
                  </p>
                </div>
                <div className="open-interest">
                  <span>Open interest</span>
                  <strong>{number(item.openInterest, 0)}</strong>
                  <small>contracts</small>
                </div>
              </div>
              <div
                className="table-scroll positioning-desktop"
                tabIndex={0}
                role="region"
                aria-label={`${item.market} positions by category`}
              >
                <table>
                  <caption className="sr-only">
                    Contract counts, reported {dateLabel(item.reportDate)}. Net
                    is long minus short.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Reporting category</th>
                      <th scope="col" className="numeric">
                        Long
                      </th>
                      <th scope="col" className="numeric">
                        Short
                      </th>
                      <th scope="col" className="numeric">
                        Net
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {positioningCategories(item).map((category) => {
                      const net = category.net;
                      return (
                        <tr key={category.name}>
                          <th scope="row">{category.name}</th>
                          <td className="numeric">
                            {number(category.long, 0)}
                          </td>
                          <td className="numeric">
                            {number(category.short, 0)}
                          </td>
                          <td className="numeric">
                            {net !== null && net > 0 ? "+" : ""}
                            {number(net, 0)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="positioning-mobile">
                {positioningCategories(item).map(category => <div className="positioning-category" key={category.name}>
                  <h4>{category.name}</h4>
                  <dl>
                    <div><dt>Long</dt><dd>{number(category.long, 0)}</dd></div>
                    <div><dt>Short</dt><dd>{number(category.short, 0)}</dd></div>
                    <div><dt>Net</dt><dd>{category.net !== null && category.net > 0 ? "+" : ""}{number(category.net, 0)}</dd></div>
                  </dl>
                </div>)}
              </div>
              <p className="positioning-unit">
                Contract specification: {item.units}. Values are contract
                counts. Net = long − short. “—” means unavailable; a reported
                zero remains 0.
              </p>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            loading
              ? "Loading CFTC positioning"
              : query
                ? "No matching futures markets"
                : "Positioning is unavailable"
          }
          loading={loading}
        >
          {query
            ? "Try a broader market name or contract code."
            : (positioning?.message ??
              "No current CFTC records were returned. No positions are inferred.")}
        </EmptyState>
      )}
      <SourceNote envelope={positioning} />
      <Notice>
        These categories do not cover every participant or position type. A free
        public options-chain or dark-pool feed is not connected; CFTC futures
        reports are a separate source.
      </Notice>
    </section>
  );
}

export function PublicNews({
  symbol,
  theme,
  filings,
  loading,
}: {
  symbol: string;
  theme: "dark" | "light";
  filings?: Envelope<Filing[]>;
  loading: boolean;
}) {
  const broadNews = usesBroadMarketNews(symbol);
  return (
    <div className="view-stack">
      <FilingsPanel filings={filings} loading={loading} />
      <section className="panel">
        <PanelHeader
          eyebrow="HOSTED BY TRADINGVIEW"
          title={
            broadNews
              ? "Broad-market headlines"
              : `${symbol} · Market headlines`
          }
        />
        <p className="panel-intro">
          {broadNews
            ? `Stock-market headlines for wider context while viewing ${symbol}. This is a broad market feed, not news specific to the fund.`
            : `Publisher headlines filtered for ${symbol} in a separate hosted view.`}{" "}
          This feed is distinct from the SEC filings above and is not used as
          input to our published research.
        </p>
        <TradingViewWidget
          kind="news"
          symbol={symbol}
          theme={theme}
          newsScope={broadNews ? "market" : "symbol"}
        />
      </section>
    </div>
  );
}
