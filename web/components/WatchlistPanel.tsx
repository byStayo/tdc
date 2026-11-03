"use client";
import type { FormEvent } from "react";
import { ChevronRight, Plus, ShieldCheck, Trash2 } from "lucide-react";
import type { Quote } from "@/lib/contracts";
import { EmptyState, Notice, number, PanelHeader, QuoteChange } from "./ui";

interface Props {
  publicMode?: boolean;
  watchlist: string[];
  symbol: string;
  quotes: Quote[];
  watchlistInput: string;
  watchlistError: string;
  storageMessage: string;
  onInput: (value: string) => void;
  onAdd: (event: FormEvent<HTMLFormElement>) => void;
  onToggle: (symbol: string) => void;
  onSelect: (symbol: string) => void;
}
export default function WatchlistPanel({
  publicMode = false,
  watchlist,
  symbol,
  quotes,
  watchlistInput,
  watchlistError,
  storageMessage,
  onInput,
  onAdd,
  onToggle,
  onSelect,
}: Props) {
  return (
    <section className="panel">
      <PanelHeader eyebrow="YOUR RESEARCH UNIVERSE" title="My watchlist">
        <span className="count-badge">{watchlist.length} / 30</span>
      </PanelHeader>
      <p className="panel-intro">
        {publicMode
          ? "Choose an instrument to explore its hosted market view. Your watchlist stays on this device."
          : "Choose a symbol to load its research workspace. Prices appear only when returned by the connected market source."}
      </p>
      <form className="watchlist-form" onSubmit={onAdd}>
        <label className="field-search">
          <Plus size={16} />
          <span className="sr-only">Symbol to add to watchlist</span>
          <input
            value={watchlistInput}
            onChange={(event) => {
              onInput(event.target.value);
            }}
            placeholder="Add a symbol, e.g. AAPL"
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={16}
            aria-invalid={!!watchlistError}
            aria-describedby={watchlistError ? "watchlist-error" : undefined}
          />
        </label>
        <button className="button button-primary" type="submit">
          Add symbol
        </button>
      </form>
      {watchlistError && (
        <p className="field-error" role="alert" id="watchlist-error">
          {watchlistError}
        </p>
      )}
      {storageMessage && <Notice>{storageMessage}</Notice>}
      {watchlist.length ? (
        <div className="watchlist-table">
          {watchlist.map((item) => {
            const quote = quotes.find((row) => row.symbol === item);
            return (
              <div
                className={`watchlist-table-row ${item === symbol ? "selected" : ""}`}
                key={item}
              >
                <button
                  className="watchlist-symbol-button"
                  onClick={() => {
                    onSelect(item);
                  }}
                >
                  <span className="ticker-mark">{item.slice(0, 2)}</span>
                  <span>
                    <strong>{item}</strong>
                    <small>{quote?.name ?? "Open instrument research"}</small>
                  </span>
                </button>
                {publicMode ? (
                  <ChevronRight size={16} className="muted" />
                ) : (
                  <div className="watchlist-price">
                    <strong>{quote ? `$${number(quote.close)}` : "—"}</strong>
                    {quote ? (
                      <QuoteChange quote={quote} />
                    ) : (
                      <span>Load to view</span>
                    )}
                  </div>
                )}
                <button
                  className="icon-button remove-watch"
                  aria-label={`Remove ${item} from watchlist`}
                  onClick={() => onToggle(item)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState title="Make space for what matters">
          Add your first ticker to start a personal research watchlist.
        </EmptyState>
      )}
      <p className="local-storage-note">
        <ShieldCheck size={13} />
        Saved in this browser. No account or trade execution is required.
      </p>
    </section>
  );
}
