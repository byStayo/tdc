"use client";

import { archiveDisplayTitle } from "@/lib/archive-title";
import { useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  FileText,
  Filter,
  Search,
} from "lucide-react";
import type {
  Envelope,
  Indicator,
  NewsItem,
  OptionContract,
  ResearchItem,
  SourceState,
} from "@/lib/contracts";
import {
  compactNumber,
  dateLabel,
  EmptyState,
  ExternalLink,
  Notice,
  number,
  PanelHeader,
  SourceNote,
  StatusBadge,
  timestamp,
} from "./ui";

export function NewsPanel({
  news,
  loading,
  compact = false,
  onViewAll,
}: {
  news?: Envelope<NewsItem[]>;
  loading: boolean;
  compact?: boolean;
  onViewAll?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sentiment, setSentiment] = useState("all");
  const entries = useMemo(
    () =>
      (news?.data ?? []).filter(
        (item) =>
          (sentiment === "all" ||
            (item.sentiment ?? "unrated") === sentiment) &&
          `${item.title} ${item.publisher} ${item.description}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [news, sentiment, query],
  );
  const shown = compact ? entries.slice(0, 3) : entries;
  return (
    <section className="panel news-panel">
      <PanelHeader
        eyebrow="THE INFORMATION FLOW"
        title={compact ? "In the news" : "News & sentiment"}
      >
        {compact && onViewAll ? (
          <button className="text-button" onClick={onViewAll}>
            All news <ChevronRight size={15} />
          </button>
        ) : (
          <StatusBadge status={news?.status} />
        )}
      </PanelHeader>
      {!compact && (
        <div className="panel-toolbar">
          <label className="field-search">
            <Search size={16} />
            <span className="sr-only">Filter news</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter headlines or publishers"
            />
          </label>
          <label className="select-field">
            <span className="sr-only">Sentiment filter</span>
            <select
              value={sentiment}
              onChange={(event) => setSentiment(event.target.value)}
            >
              <option value="all">All sentiment</option>
              <option value="positive">Positive</option>
              <option value="neutral">Neutral</option>
              <option value="negative">Negative</option>
              <option value="unrated">Not rated</option>
            </select>
          </label>
        </div>
      )}
      {shown.length ? (
        <div className="news-list">
          {shown.map((item, i) => (
            <article className="news-item" key={item.id}>
              <span className="news-number" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="news-item-body">
                <div className="article-meta">
                  <span>{item.publisher}</span>
                  <span>{dateLabel(item.publishedAt)}</span>
                  {item.sentiment && (
                    <span className={`sentiment sentiment-${item.sentiment}`}>
                      {item.sentiment}
                    </span>
                  )}
                </div>
                <h3>
                  <ExternalLink href={item.url}>{archiveDisplayTitle(item)}</ExternalLink>
                </h3>
                {!compact && (
                  <p className="article-excerpt">{item.description}</p>
                )}
                {!compact && item.reasoning && (
                  <details className="sentiment-detail">
                    <summary>Why this sentiment?</summary>
                    <p>{item.reasoning}</p>
                    <span>
                      Sentiment classification supplied with the source article.
                    </span>
                  </details>
                )}
                {!compact && item.symbols.length > 0 && (
                  <div className="symbol-tags">
                    {item.symbols.slice(0, 8).map((symbol) => (
                      <span key={symbol}>{symbol}</span>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            loading
              ? "Loading source-linked news"
              : query || sentiment !== "all"
                ? "No matching articles"
                : "No news is available"
          }
          loading={loading}
        >
          {query || sentiment !== "all"
            ? "Try a different search or sentiment filter."
            : (news?.message ??
              "Articles appear here when a connected publisher returns coverage for this symbol.")}
        </EmptyState>
      )}
      <SourceNote envelope={news} />
    </section>
  );
}

export function OptionsPanel({
  options,
  symbol,
  loading,
}: {
  options?: Envelope<OptionContract[]>;
  symbol: string;
  loading: boolean;
}) {
  const [type, setType] = useState("all");
  const [expiry, setExpiry] = useState("all");
  const expiries = [
    ...new Set((options?.data ?? []).map((item) => item.expiry)),
  ].sort();
  const effectiveExpiry =
    expiry === "all" || expiries.includes(expiry) ? expiry : "all";
  const rows = (options?.data ?? []).filter(
    (item) =>
      (type === "all" || item.type === type) &&
      (effectiveExpiry === "all" || item.expiry === effectiveExpiry),
  );
  return (
    <section className="panel">
      <PanelHeader eyebrow="DERIVATIVES" title={`${symbol} options chain`}>
        <StatusBadge status={options?.status} />
      </PanelHeader>
      <p className="panel-intro">
        Reported contracts, liquidity and Greeks. An unavailable value means the
        source did not provide it.
      </p>
      {(options?.data.length ?? 0) > 0 && (
        <div className="panel-toolbar">
          <span className="filter-label">
            <Filter size={15} />
            {rows.length} contracts
          </span>
          <label className="select-field">
            <span className="sr-only">Contract type</span>
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
            >
              <option value="all">Calls & puts</option>
              <option value="call">Calls</option>
              <option value="put">Puts</option>
            </select>
          </label>
          <label className="select-field">
            <span className="sr-only">Expiration date</span>
            <select
              value={effectiveExpiry}
              onChange={(event) => setExpiry(event.target.value)}
            >
              <option value="all">All expirations</option>
              {expiries.map((value) => (
                <option key={value} value={value}>
                  {dateLabel(value)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {rows.length > 0 ? (
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Options chain, scroll horizontally for more columns"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col">Type</th>
                <th scope="col">Expiry</th>
                <th scope="col" className="numeric">
                  Strike
                </th>
                <th scope="col" className="numeric">
                  Price
                </th>
                <th scope="col" className="numeric">
                  Volume
                </th>
                <th scope="col" className="numeric">
                  Open interest
                </th>
                <th scope="col" className="numeric">
                  IV
                </th>
                <th scope="col" className="numeric">
                  Delta
                </th>
                <th scope="col" className="numeric">
                  Gamma
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.symbol}>
                  <th scope="row" className="contract-symbol">
                    {item.symbol}
                  </th>
                  <td>
                    <span className={`contract-type ${item.type}`}>
                      {item.type}
                    </span>
                  </td>
                  <td>{dateLabel(item.expiry)}</td>
                  <td className="numeric">${number(item.strike)}</td>
                  <td className="numeric">
                    {item.price === null ? "—" : `$${number(item.price)}`}
                  </td>
                  <td className="numeric">{compactNumber(item.volume)}</td>
                  <td className="numeric">
                    {compactNumber(item.openInterest)}
                  </td>
                  <td className="numeric">
                    {item.iv === null ? "—" : `${number(item.iv * 100)}%`}
                  </td>
                  <td className="numeric">{number(item.delta, 3)}</td>
                  <td className="numeric">{number(item.gamma, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title={
            loading
              ? "Checking options coverage"
              : options?.status === "unauthorized"
                ? "Options access is required"
                : options?.data.length
                  ? "No contracts match these filters"
                  : "Options data is not available"
          }
          loading={loading}
        >
          {options?.message ??
            "This workspace has no authorized options feed for the selected symbol. No contracts or positioning estimates are shown."}
        </EmptyState>
      )}
      <SourceNote envelope={options} />
      <Notice>
        Contract coverage depends on the source subscription. Open interest and
        Greeks are observations, not evidence of a specific investor’s intent.
      </Notice>
    </section>
  );
}

export function ArchivePanel({
  archive,
  loading,
  compact = false,
  onViewAll,
}: {
  archive?: ResearchItem[];
  loading: boolean;
  compact?: boolean;
  onViewAll?: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = (archive ?? []).filter((item) =>
    `${item.title} ${item.excerpt} ${item.author}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const shown = compact ? filtered.slice(0, 2) : filtered;
  return (
    <section className="panel archive-panel">
      <PanelHeader
        eyebrow="THE DAILY CONSENSUS"
        title={
          compact ? "From the research archive" : "Original research archive"
        }
      >
        {compact && onViewAll ? (
          <button className="text-button" onClick={onViewAll}>
            Explore <ChevronRight size={15} />
          </button>
        ) : (
          <BookOpen size={20} className="muted" />
        )}
      </PanelHeader>
      {!compact && (
        <>
          <p className="panel-intro">
            The original publication, with author attribution and publication
            dates. Historical views retain their original context.
          </p>
          <div className="panel-toolbar">
            <label className="field-search">
              <Search size={16} />
              <span className="sr-only">Search research archive</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search the research archive"
              />
            </label>
          </div>
        </>
      )}
      {shown.length ? (
        <div className={`archive-grid ${compact ? "is-compact" : ""}`}>
          {shown.map((item) => (
            <article key={item.id} className="archive-card">
              <div className="archive-card-top">
                <FileText size={18} strokeWidth={1.5} />
                <span>{dateLabel(item.publishedAt)}</span>
              </div>
              <h3>
                <ExternalLink href={item.url}>{archiveDisplayTitle(item)}</ExternalLink>
              </h3>
              <p>{item.excerpt}</p>
              <div className="archive-author">
                <span className="author-avatar" aria-hidden="true">
                  {item.author.slice(0, 1)}
                </span>
                <span>{item.author}</span>
                <ArrowRight size={15} className="muted" />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            loading
              ? "Loading original research"
              : query
                ? "No matching research"
                : "The archive is not available"
          }
          loading={loading}
        >
          {query
            ? "Try another title, topic or author."
            : "Original articles will appear with their publication dates and source links when the archive is connected."}
        </EmptyState>
      )}
    </section>
  );
}

export function TechnicalPanel({
  indicators,
  loading,
}: {
  indicators?: Indicator[];
  loading: boolean;
}) {
  return (
    <section className="panel">
      <PanelHeader
        eyebrow="PRICE-DERIVED CONTEXT"
        title="Technical observations"
      />
      <p className="panel-intro">
        Calculated from the available daily bars. Each observation includes its
        method so you can examine the evidence.
      </p>
      {indicators?.length ? (
        <div className="indicator-grid">
          {indicators.map((item) => (
            <article className="indicator-card" key={item.id}>
              <span className="indicator-name">{item.name}</span>
              <strong className="indicator-value">
                {item.value === null
                  ? "—"
                  : item.unit === "USD" || item.unit === "$"
                    ? `$${number(item.value)}`
                    : `${number(item.value)}${item.unit === "%" ? "%" : item.unit ? ` ${item.unit}` : ""}`}
              </strong>
              <p>{item.interpretation}</p>
              <details>
                <summary>Calculation method</summary>
                <p>{item.methodology}</p>
              </details>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            loading
              ? "Calculating observations"
              : "No technical observations yet"
          }
          loading={loading}
        >
          A sufficient price history is needed before an indicator can be
          calculated.
        </EmptyState>
      )}
    </section>
  );
}

export function SourcesPanel({
  sources,
  loading,
  publicMode = false,
}: {
  sources?: SourceState[];
  loading: boolean;
  publicMode?: boolean;
}) {
  return (
    <div className="view-stack">
      <section className="panel">
        <PanelHeader
          eyebrow="TRANSPARENCY BY DEFAULT"
          title="Sources & coverage"
        />
        <p className="panel-intro">
          Every connection has its own coverage and update time. A connected
          source does not imply real-time data or complete market coverage.
        </p>
        {sources?.length ? (
          <div className="source-list">
            {sources.map((source) => (
              <article className="source-detail" key={source.id}>
                <div className="source-detail-heading">
                  <h3>
                    <ExternalLink href={source.url}>{source.name}</ExternalLink>
                  </h3>
                  <StatusBadge status={source.status} />
                </div>
                <p>{source.description}</p>
                <span className="source-time">
                  {source.asOf
                    ? `Source timestamp · ${timestamp(source.asOf)}`
                    : "No source timestamp supplied"}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title={
              loading
                ? "Checking source connections"
                : "Source status is unavailable"
            }
            loading={loading}
          >
            Refresh the workspace to retrieve the latest connection status.
          </EmptyState>
        )}
      </section>
      <section className="panel methodology-panel">
        <PanelHeader
          eyebrow="HOW TO READ THIS WORKSPACE"
          title="Evidence before conclusions"
        />
        <div className="method-grid">
          <article>
            <span className="method-number">01</span>
            <h3>
              {publicMode ? "Hosted market views" : "Market observations"}
            </h3>
            <p>
              {publicMode
                ? "Charts, technical ratings and headlines are provided inside TradingView’s hosted widgets. Their data stays within the provider’s view and is not extracted for our research. Check the timestamps and delays shown there."
                : "Quotes, daily prices and volume come from the named market source. Use their timestamps to understand the trading session. Period returns compare the first and last available closes."}
            </p>
          </article>
          <article>
            <span className="method-number">02</span>
            <h3>
              {publicMode
                ? "Published market research"
                : "AI-assisted synthesis"}
            </h3>
            <p>
              {publicMode
                ? "Daily Brief is the shared market-wide edition. Instrument reports provide separate published analysis for SPY, QQQ, IWM, DIA and TLT, with supporting views, counterpoints, source dates and limitations. Related futures positions are not ETF fund flows. Neither edition is personalized investment advice."
                : "A brief is generated only when requested. It draws on available evidence, presents supporting and opposing views, and links its citations. Read the sources and limitations alongside it."}
            </p>
          </article>
          <article>
            <span className="method-number">03</span>
            <h3>
              {publicMode
                ? "Public records, in context"
                : "News & original research"}
            </h3>
            <p>
              {publicMode
                ? "FRED observations, SEC filings and CFTC reports retain their own reporting dates. CFTC categories are aggregate positions, not investor identities. Filing dates differ from reporting periods. Historical articles preserve their original author, date and context."
                : "Publisher sentiment is an attributed classification, not a price forecast. Original research keeps its author and historical publication date; it is not a current recommendation."}
            </p>
          </article>
          <article>
            <span className="method-number">04</span>
            <h3>Visible limitations</h3>
            <p>
              {publicMode
                ? "The service is free to all readers. A full public options chain and dark-pool feed are not connected. No live institutional intent is inferred, trades are not executed, and outcomes are not guaranteed."
                : "Missing options, dark-pool or professional analysis feeds remain visibly unavailable. The workspace does not infer institutional activity, execute trades or guarantee outcomes."}
            </p>
          </article>
        </div>
      </section>
    </div>
  );
}
