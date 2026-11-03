"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Menu,
  Moon,
  RefreshCw,
  Search,
  Star,
  Sun,
  X,
} from "lucide-react";
import Navigation, { NAVIGATION, type View } from "./Navigation";
import ContextRail from "./ContextRail";
import WatchlistPanel from "./WatchlistPanel";
import MacroPanel from "./MacroPanel";
import PublicMarket from "./PublicMarket";
import {
  FilingsPanel,
  PositioningPanel,
  PublicNews,
} from "./PublicEvidencePanels";
import type { ResearchResponse, Workspace } from "@/lib/contracts";
import MarketChart, { type Period } from "./MarketChart";
import {
  ArchivePanel,
  NewsPanel,
  OptionsPanel,
  SourcesPanel,
  TechnicalPanel,
} from "./EvidencePanels";
import ResearchBriefPanel from "./ResearchBriefPanel";
import {
  compactNumber,
  localDateLabel,
  ExternalLink,
  number,
  PanelHeader,
  QuoteChange,
  timestamp,
} from "./ui";

const VIEW_COPY: Record<View, { title: string; description: string }> = {
  brief: {
    title: "Your daily perspective.",
    description: "Independent market research. Open to everyone.",
  },
  market: {
    title: "Read the market.",
    description: "Price, volume and the observations behind the numbers.",
  },
  positioning: {
    title: "Positioning, with perspective.",
    description:
      "Reported futures categories, with dates and limitations in view.",
  },
  news: {
    title: "Stay close to the source.",
    description:
      "Official disclosures and hosted headlines, clearly separated.",
  },
  archive: {
    title: "Ideas worth revisiting.",
    description: "The original Daily Consensus research, preserved in context.",
  },
  watchlist: {
    title: "Keep your focus.",
    description: "The instruments you want to follow, saved on this device.",
  },
  sources: {
    title: "Know what’s behind it.",
    description: "The sources, methods and limitations of this workspace.",
  },
};
const DEFAULT_WATCHLIST = ["SPY", "QQQ", "IWM", "TLT", "GLD"];
const validSymbol = (value: string) => /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(value);

export default function ResearchDesk() {
  const [view, setView] = useState<View>("brief");
  const [symbol, setSymbol] = useState("SPY");
  const [search, setSearch] = useState("");
  const [searchError, setSearchError] = useState("");
  const [period, setPeriod] = useState<Period>("3M");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [brief, setBrief] = useState<ResearchResponse | null>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const [watchlist, setWatchlist] = useState(DEFAULT_WATCHLIST);
  const [storageReady, setStorageReady] = useState(false);
  const [storageMessage, setStorageMessage] = useState("");
  const [watchlistInput, setWatchlistInput] = useState("");
  const [watchlistError, setWatchlistError] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const researchRequest = useRef<AbortController | null>(null);
  const publicMode = workspace?.mode !== "private";

  const generateBrief = useCallback(async () => {
    researchRequest.current?.abort();
    const controller = new AbortController();
    researchRequest.current = controller;
    setResearchBusy(true);
    setBrief(null);
    try {
      const response = await fetch("/api/research", {
        method: publicMode ? "GET" : "POST",
        ...(publicMode
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ symbol }),
            }),
        signal: controller.signal,
      });
      const result: ResearchResponse = await response.json();
      if (!response.ok && !result.message)
        throw new Error(
          `Research is unavailable (HTTP ${response.status}). Please try again.`,
        );
      if (!controller.signal.aborted) setBrief(result);
    } catch (cause) {
      if (!controller.signal.aborted)
        setBrief({
          status: "unavailable",
          data: null,
          message:
            cause instanceof Error
              ? cause.message
              : "Research is unavailable. Please try again.",
        });
    } finally {
      if (!controller.signal.aborted) setResearchBusy(false);
    }
  }, [publicMode, symbol]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("tdc-watchlist-v1");
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed))
          setWatchlist(
            [
              ...new Set(
                parsed.filter(
                  (item): item is string =>
                    typeof item === "string" && validSymbol(item),
                ),
              ),
            ].slice(0, 30),
          );
      }
      const savedTheme = localStorage.getItem("tdc-theme");
      const nextTheme = savedTheme === "light" ? "light" : "dark";
      setTheme(nextTheme);
      document.documentElement.dataset.theme = nextTheme;
    } catch {
      setStorageMessage(
        "Device storage is unavailable. Your watchlist will last for this visit.",
      );
    }
    setStorageReady(true);
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) &&
        !target.isContentEditable
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("keydown", shortcut);
      researchRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      localStorage.setItem("tdc-watchlist-v1", JSON.stringify(watchlist));
    } catch {
      setStorageMessage(
        "Device storage is unavailable. Your watchlist will last for this visit.",
      );
    }
  }, [watchlist, storageReady]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setWorkspace(null);
    fetch(
      `/api/workspace?symbol=${encodeURIComponent(symbol)}&range=${period}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `The workspace could not be loaded (HTTP ${response.status}). Please try again.`,
          );
        const data: Workspace = await response.json();
        if (!data.quotes || !data.history || !data.sources)
          throw new Error(
            "The source returned an incomplete workspace. Please refresh to try again.",
          );
        return data;
      })
      .then((data) => {
        if (!controller.signal.aborted) setWorkspace(data);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "The workspace is unavailable. Please try again.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [symbol, period, refresh]);

  useEffect(() => {
    if (!publicMode) return;
    void generateBrief();
    return () => researchRequest.current?.abort();
  }, [publicMode, symbol, refresh, generateBrief]);

  const selectedQuote = workspace?.quotes.data.find(
    (quote) => quote.symbol === symbol,
  );
  const quotes = workspace?.quotes.data ?? [];
  const isWatched = watchlist.includes(symbol);

  function navigate(next: View) {
    setView(next);
    dialogRef.current?.close();
    setMenuOpen(false);
  }
  function selectSymbol(next: string) {
    if (next === symbol) return;
    researchRequest.current?.abort();
    setResearchBusy(false);
    setBrief(null);
    setWorkspace(null);
    setLoading(true);
    setSymbol(next);
    setSearch("");
    setSearchError("");
  }
  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = search.trim().toUpperCase().replace(/^\$/, "");
    if (!validSymbol(next)) {
      setSearchError("Enter a valid ticker, such as SPY or BRK.B.");
      return;
    }
    selectSymbol(next);
    setSearch("");
    setSearchError("");
    if (view === "archive" || view === "sources" || view === "watchlist")
      setView("brief");
  }
  function toggleWatch(next: string) {
    if (!watchlist.includes(next) && watchlist.length >= 30) {
      setWatchlistError(
        "Your watchlist holds up to 30 symbols. Remove one before adding another.",
      );
      setView("watchlist");
      return;
    }
    setWatchlist((current) =>
      current.includes(next)
        ? current.filter((item) => item !== next)
        : [...current, next],
    );
    setWatchlistError("");
  }
  function addWatchlist(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = watchlistInput.trim().toUpperCase().replace(/^\$/, "");
    if (!validSymbol(next)) {
      setWatchlistError("Enter a valid ticker, such as SPY or BRK.B.");
      return;
    }
    if (watchlist.includes(next)) {
      setWatchlistError(`${next} is already in your watchlist.`);
      return;
    }
    if (watchlist.length >= 30) {
      setWatchlistError(
        "Your watchlist holds up to 30 symbols. Remove one before adding another.",
      );
      return;
    }
    setWatchlist((current) => [...current, next]);
    setWatchlistInput("");
    setWatchlistError("");
  }
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("tdc-theme", next);
    } catch {
      /* Theme remains usable for the current visit. */
    }
  }

  return (
    <div className="research-app">
      <a className="skip-link" href="#main-content">
        Skip to research
      </a>
      <aside className="sidebar">
        <Navigation view={view} onNavigate={navigate} />
      </aside>
      <dialog
        className="mobile-nav-dialog"
        ref={dialogRef}
        onClose={() => setMenuOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
        aria-label="Navigation"
      >
        <div className="mobile-nav-content">
          <button
            className="icon-button close-menu"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close navigation"
          >
            <X size={20} />
          </button>
          <Navigation view={view} onNavigate={navigate} />
        </div>
      </dialog>
      <div className="workspace-shell">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            onClick={() => {
              dialogRef.current?.showModal();
              setMenuOpen(true);
            }}
          >
            <Menu size={21} />
          </button>
          <span className="topbar-location">
            Workspace<span>/</span>
            <strong>
              {NAVIGATION.find((item) => item.id === view)?.label}
            </strong>
          </span>
          <form className="ticker-search" onSubmit={submitSearch}>
            <Search size={16} aria-hidden="true" />
            <label htmlFor="ticker-search" className="sr-only">
              Search a ticker symbol
            </label>
            <input
              id="ticker-search"
              ref={searchRef}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSearchError("");
              }}
              placeholder="Search a ticker…"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-describedby={searchError ? "search-error" : undefined}
              aria-invalid={!!searchError}
              maxLength={16}
            />
            <button
              type="submit"
              className="search-submit"
              aria-label="Load ticker"
            >
              <ArrowRight size={15} />
            </button>
            <kbd aria-hidden="true">/</kbd>
          </form>
          <div className="topbar-actions">
            <button
              className="icon-button"
              aria-label="Refresh workspace"
              title="Refresh workspace"
              onClick={() => setRefresh((value) => value + 1)}
              disabled={loading}
            >
              <RefreshCw size={17} className={loading ? "spin" : ""} />
            </button>
            <button
              className="icon-button"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={toggleTheme}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <span className="free-service-badge">Free for everyone</span>
          </div>
        </header>
        {searchError && (
          <p className="search-error" id="search-error" role="alert">
            {searchError}
          </p>
        )}
        <div className="workspace-content">
          <main
            id="main-content"
            className="main-workspace"
            aria-busy={loading}
          >
            <p className="sr-only" role="status" aria-live="polite">
              {loading
                ? `Loading ${symbol} research workspace.`
                : workspace
                  ? `${symbol} research workspace loaded.`
                  : "The research workspace could not be loaded."}
            </p>
            <div className="page-heading">
              <div>
                <p className="eyebrow">
                  FREE MARKET RESEARCH{" "}
                  <span className="eyebrow-divider">/</span>{" "}
                  {workspace
                    ? localDateLabel(workspace.fetchedAt).toUpperCase()
                    : "THE DAILY CONSENSUS"}
                </p>
                <h1>{VIEW_COPY[view].title}</h1>
                <p className="page-description">
                  {VIEW_COPY[view].description}
                </p>
              </div>
              <div className="heading-status">
                <span className="market-status">
                  <span
                    className={`status-dot ${workspace ? "connected-dot" : ""}`}
                  />
                  {publicMode
                    ? "Open research desk"
                    : workspace
                      ? workspace.market.state.replaceAll("_", " ")
                      : loading
                        ? "Connecting sources"
                        : "Sources unavailable"}
                </span>
                <span>
                  {workspace
                    ? `Fetched ${timestamp(workspace.fetchedAt)}`
                    : "Source timestamps shown with data"}
                </span>
              </div>
            </div>
            {error && (
              <div className="error-banner" role="alert">
                <div>
                  <strong>We couldn’t load this workspace.</strong>
                  <p>{error}</p>
                </div>
                <button
                  className="button button-secondary"
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  <RefreshCw size={14} />
                  Try again
                </button>
              </div>
            )}
            {!publicMode &&
              workspace &&
              quotes.length > 0 &&
              !["archive", "sources", "watchlist"].includes(view) && (
                <div className="quote-strip" aria-label="Market overview">
                  {quotes.slice(0, 5).map((quote) => (
                    <button
                      key={quote.symbol}
                      className={`quote-card ${symbol === quote.symbol ? "selected" : ""}`}
                      onClick={() => selectSymbol(quote.symbol)}
                      aria-pressed={symbol === quote.symbol}
                    >
                      <div>
                        <strong>{quote.symbol}</strong>
                        <span>{quote.name}</span>
                      </div>
                      <div>
                        <span className="quote-price">
                          ${number(quote.close)}
                        </span>
                        <QuoteChange quote={quote} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            <div className="view-stack">
              {view === "brief" && (
                <>
                  <ResearchBriefPanel
                    symbol={symbol}
                    workspace={workspace}
                    brief={brief}
                    busy={researchBusy}
                    onGenerate={generateBrief}
                    publicEdition={publicMode}
                  />
                  {publicMode ? (
                    <>
                      <PublicMarket
                        symbol={symbol}
                        theme={theme}
                        compact
                        isWatched={isWatched}
                        onWatch={() => toggleWatch(symbol)}
                      />
                      <FilingsPanel
                        filings={workspace?.filings}
                        loading={loading}
                        compact
                        onViewAll={() => navigate("news")}
                      />
                    </>
                  ) : (
                    <>
                      <MarketChart
                        symbol={symbol}
                        history={workspace?.history}
                        quote={selectedQuote}
                        period={period}
                        onPeriod={setPeriod}
                        loading={loading}
                      />
                      <NewsPanel
                        news={workspace?.news}
                        loading={loading}
                        compact
                        onViewAll={() => navigate("news")}
                      />
                    </>
                  )}
                  <ArchivePanel
                    archive={workspace?.archive}
                    loading={loading}
                    compact
                    onViewAll={() => navigate("archive")}
                  />
                </>
              )}
              {view === "market" && publicMode && (
                <PublicMarket
                  symbol={symbol}
                  theme={theme}
                  isWatched={isWatched}
                  onWatch={() => toggleWatch(symbol)}
                />
              )}
              {view === "market" && !publicMode && (
                <>
                  <div className="instrument-toolbar">
                    <div>
                      <span className="eyebrow">SELECTED INSTRUMENT</span>
                      <strong>{symbol}</strong>
                    </div>
                    <button
                      className={`button button-secondary ${isWatched ? "is-saved" : ""}`}
                      onClick={() => toggleWatch(symbol)}
                    >
                      <Star
                        size={15}
                        fill={isWatched ? "currentColor" : "none"}
                      />
                      {isWatched ? "On your watchlist" : "Add to watchlist"}
                    </button>
                  </div>
                  <MarketChart
                    symbol={symbol}
                    history={workspace?.history}
                    quote={selectedQuote}
                    period={period}
                    onPeriod={setPeriod}
                    loading={loading}
                  />
                  {selectedQuote && (
                    <div className="session-stats">
                      {[
                        ["Open", `$${number(selectedQuote.open)}`],
                        ["Session high", `$${number(selectedQuote.high)}`],
                        ["Session low", `$${number(selectedQuote.low)}`],
                        ["Volume", compactNumber(selectedQuote.volume)],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <span>{label}</span>
                          <strong>{value}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                  <TechnicalPanel
                    indicators={workspace?.indicators}
                    loading={loading}
                  />
                  {workspace?.company.data && (
                    <section className="panel company-panel">
                      <PanelHeader
                        eyebrow="INSTRUMENT PROFILE"
                        title={workspace.company.data.name}
                      />
                      <p>
                        {workspace.company.data.description ||
                          "The source did not provide a description for this instrument."}
                      </p>
                      <div className="company-facts">
                        {workspace.company.data.exchange && (
                          <span>
                            Exchange
                            <strong>{workspace.company.data.exchange}</strong>
                          </span>
                        )}
                        {workspace.company.data.sector && (
                          <span>
                            Sector
                            <strong>{workspace.company.data.sector}</strong>
                          </span>
                        )}
                        {workspace.company.data.marketCap !== null && (
                          <span>
                            Market cap
                            <strong>
                              ${compactNumber(workspace.company.data.marketCap)}
                            </strong>
                          </span>
                        )}
                      </div>
                      {workspace.company.data.homepage && (
                        <ExternalLink
                          href={workspace.company.data.homepage}
                          className="text-link"
                        >
                          Official website
                        </ExternalLink>
                      )}
                    </section>
                  )}
                </>
              )}
              {view === "positioning" && publicMode && (
                <PositioningPanel
                  positioning={workspace?.positioning}
                  loading={loading}
                />
              )}
              {view === "positioning" && !publicMode && (
                <OptionsPanel
                  key={symbol}
                  options={workspace?.options}
                  symbol={symbol}
                  loading={loading}
                />
              )}
              {view === "news" &&
                (publicMode ? (
                  <PublicNews
                    symbol={symbol}
                    theme={theme}
                    filings={workspace?.filings}
                    loading={loading}
                  />
                ) : (
                  <NewsPanel news={workspace?.news} loading={loading} />
                ))}
              {view === "archive" && (
                <ArchivePanel archive={workspace?.archive} loading={loading} />
              )}
              {view === "sources" && (
                <SourcesPanel
                  sources={workspace?.sources}
                  loading={loading}
                  publicMode={publicMode}
                />
              )}
              {view === "watchlist" && (
                <WatchlistPanel
                  publicMode={publicMode}
                  watchlist={watchlist}
                  symbol={symbol}
                  quotes={quotes}
                  watchlistInput={watchlistInput}
                  watchlistError={watchlistError}
                  storageMessage={storageMessage}
                  onInput={(value) => {
                    setWatchlistInput(value);
                    setWatchlistError("");
                  }}
                  onAdd={addWatchlist}
                  onToggle={toggleWatch}
                  onSelect={(next) => {
                    selectSymbol(next);
                    navigate("market");
                  }}
                />
              )}
            </div>
            <div className="mobile-macro-context">
              <MacroPanel macro={workspace?.macro} loading={loading} />
            </div>
            <footer className="workspace-footer">
              <span>The Daily Consensus</span>
              <p>
                Research for perspective. Not a recommendation to buy or sell.
              </p>
              <button onClick={() => navigate("sources")}>
                Sources & methodology <ArrowUpRight size={12} />
              </button>
            </footer>
          </main>
          <ContextRail
            publicMode={publicMode}
            workspace={workspace}
            quotes={quotes}
            watchlist={watchlist}
            symbol={symbol}
            loading={loading}
            onNavigate={navigate}
            onSelect={(next) => {
              selectSymbol(next);
              navigate("market");
            }}
          />
        </div>
      </div>
    </div>
  );
}
