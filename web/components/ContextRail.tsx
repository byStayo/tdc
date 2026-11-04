"use client";
import {
  ArrowRight,
  BookOpen,
  ChevronRight,
  Plus,
} from "lucide-react";
import type { Quote, Workspace } from "@/lib/contracts";
import type { View } from "./Navigation";
import MacroPanel from "./MacroPanel";
import { number, StatusBadge } from "./ui";
interface Props {
  publicMode?: boolean;
  workspace: Workspace | null;
  quotes: Quote[];
  watchlist: string[];
  symbol: string;
  loading: boolean;
  onNavigate: (view: View) => void;
  onSelect: (symbol: string) => void;
}
export default function ContextRail({
  publicMode = false,
  workspace,
  quotes,
  watchlist,
  symbol,
  loading,
  onNavigate,
  onSelect,
}: Props) {
  const connectedCount =
    workspace?.sources.filter((source) => source.status === "ok").length ?? 0;
  return (
    <aside className="context-rail" aria-label="Research context">
      <section className="rail-section">
        <div className="rail-heading">
          <h2>On your radar</h2>
          <button
            className="icon-button small-icon"
            onClick={() => onNavigate("watchlist")}
            aria-label="Manage watchlist"
          >
            <Plus size={16} />
          </button>
        </div>
        <p className="rail-description">Your personal market shortlist.</p>
        <div className="rail-watchlist">
          {watchlist.slice(0, 6).map((item) => {
            const quote = quotes.find((row) => row.symbol === item);
            return (
              <button
                className={`rail-watch-item ${symbol === item ? "selected" : ""}`}
                key={item}
                onClick={() => onSelect(item)}
                aria-pressed={symbol === item}
              >
                <span className="mini-ticker-mark" aria-hidden="true">{item}</span>
                <span className="rail-watch-name">
                  <strong>{item}</strong>
                  {quote?.name && <small>{quote.name}</small>}
                </span>
                {publicMode ? (
                  <ChevronRight size={14} className="rail-watch-chevron" />
                ) : (
                  <span className="rail-watch-value">
                    <strong>{quote ? number(quote.close) : "—"}</strong>
                    {quote?.changePercent !== null && quote ? (
                      <span
                        className={
                          quote.changePercent !== null &&
                          quote.changePercent >= 0
                            ? "positive"
                            : "negative"
                        }
                      >
                        {quote.changePercent !== null &&
                        quote.changePercent >= 0
                          ? "+"
                          : ""}
                        {number(quote.changePercent)}%
                      </span>
                    ) : (
                      <small>
                        {quote ? "Change unavailable" : "No quote loaded"}
                      </small>
                    )}
                  </span>
                )}
              </button>
            );
          })}
          {watchlist.length === 0 && (
            <p className="rail-empty">Add a ticker to start your watchlist.</p>
          )}
        </div>
        <button className="rail-link" onClick={() => onNavigate("watchlist")}>
          Manage watchlist
          <ArrowRight size={14} />
        </button>
      </section>
      <MacroPanel macro={workspace?.macro} loading={loading} />
      <section className="rail-section">
        <div className="rail-heading">
          <h2>Evidence check</h2>
          <span className="source-count">
            {workspace ? `${connectedCount}/${workspace.sources.length}` : "—"}
          </span>
        </div>
        <p className="rail-description">Know what this view is built on.</p>
        {workspace?.sources.length ? (
          <div className="rail-source-list">
            {workspace.sources.map((source) => (
              <div className="rail-source-row" key={source.id}>
                <div>
                  <span
                    className={`status-dot status-color-${source.status}`}
                  />
                  <strong>{source.name}</strong>
                </div>
                <StatusBadge status={source.status} />
              </div>
            ))}
          </div>
        ) : (
          <p className="rail-empty">
            {loading
              ? "Checking source availability…"
              : "Source status is not available."}
          </p>
        )}
        <button className="rail-link" onClick={() => onNavigate("sources")}>
          Review source coverage
          <ArrowRight size={14} />
        </button>
      </section>
      <section className="rail-note">
        <span className="rail-note-icon">
          <BookOpen size={20} strokeWidth={1.5} />
        </span>
        <p className="eyebrow">A NOTE ON PERSPECTIVE</p>
        <h3>
          Conviction starts
          <br />
          with context.
        </h3>
        <p>
          A price is one observation. Read the sources, consider the opposing
          view, and notice what’s missing.
        </p>
        <button className="text-button" onClick={() => onNavigate("sources")}>
          Our methodology <ArrowRight size={14} />
        </button>
      </section>
    </aside>
  );
}
