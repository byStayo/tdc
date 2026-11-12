"use client";
import { publicationNotice } from "@/lib/display-format";
import currentReview from "@/lib/consensus/reviewed-developments.json";
import type { ReviewedSource } from "@/lib/consensus/reviewed";

import {
  ArrowRight,
  Activity,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Scale,
  Sparkles,
} from "lucide-react";
import type { ResearchResponse, Workspace } from "@/lib/contracts";
import { ExternalLink, Notice, timestamp } from "./ui";
import ObservedMarketContext from "./ObservedMarketContext";

export default function ResearchBriefPanel({
  symbol,
  workspace,
  brief,
  busy,
  onGenerate,
  publicEdition = false,
  instrumentEdition = false,
}: {
  symbol: string;
  workspace: Workspace | null;
  brief: ResearchResponse | null;
  busy: boolean;
  onGenerate: () => void;
  publicEdition?: boolean;
  instrumentEdition?: boolean;
}) {
  const availableNews = workspace?.news.data.length ?? 0;
  const availableBars = workspace?.history.data.length ?? 0;
  // A scope/ticker change must never flash another publication under this label.
  const visibleBrief = publicEdition && brief && (instrumentEdition
    ? brief.scope !== 'instrument' || brief.symbol !== symbol
    : brief.scope !== 'market') ? null : brief;
  const sources = visibleBrief?.sources ?? [];
  const reviewedSources: ReviewedSource[] = currentReview.sources as ReviewedSource[];
  const clockSources = publicEdition ? reviewedSources.filter(clock => reviewedSources.some(document =>
    document.publicationTimeSourceId === clock.id && sources.some(citation => citation.url === document.url))) : [];
  const research = visibleBrief?.data;
  const unavailableEdition = publicEdition && !!visibleBrief && !research && !busy;
  return (
    <section
      className={`brief-panel ${research ? "has-research" : ""}`}
      aria-label={
        publicEdition
          ? instrumentEdition ? `Published ${symbol} instrument research` : "Latest published market research"
          : "Daily market context and optional AI research"
      }
    >
      <p className="sr-only" role="status" aria-live="polite">
        {busy
          ? publicEdition
            ? instrumentEdition ? `Loading the published ${symbol} report.` : "Loading the latest published market brief."
            : "Reading the evidence and preparing your brief."
          : research
            ? "Your research brief is ready."
            : (visibleBrief?.message ?? "The published report will appear here.")}
      </p>
      <div className="brief-topline">
        <span className="eyebrow">
          <span className="brief-mark" />
          <span>
            {publicEdition
              ? instrumentEdition ? `${symbol} · ${unavailableEdition ? "INSTRUMENT RESEARCH" : "PUBLISHED INSTRUMENT REPORT"}` : "THE DAILY CONSENSUS · PUBLISHED BRIEF"
              : "THE EVIDENCE, TOGETHER"}
          </span>
        </span>
        <span className="small-label">
          {publicEdition ? (
            <BookOpen size={13} />
          ) : research ? (
            <Sparkles size={13} />
          ) : (
            <Activity size={13} />
          )}
          {publicEdition
            ? "Published research"
            : research
              ? "AI-assisted research"
              : "Market observations"}
        </span>
      </div>
      <h2>
        {research?.headline ??
          (unavailableEdition ? instrumentEdition && visibleBrief?.status === "unconfigured" ? `No published ${symbol} report yet.` : "The published report is currently unavailable." : publicEdition
            ? instrumentEdition ? `${symbol}, in perspective.` : "Markets, in perspective."
            : `A clearer view of ${symbol}.`)}
      </h2>
      {publicEdition && (
        <p className="published-edition-meta">
          {unavailableEdition ? "Publication unavailable" : instrumentEdition ? `${symbol} research · Related futures context` : "Market-wide research"}
          {visibleBrief?.createdAt
            ? ` · Published ${timestamp(visibleBrief.createdAt)}`
            : unavailableEdition ? "" : " · Latest edition"}
        </p>
      )}
      <p className="brief-summary">
        {research?.summary ??
          (unavailableEdition ? instrumentEdition ? "Choose another covered instrument above, or read the market-wide Daily Brief." : "Try loading the saved brief again." : publicEdition
            ? instrumentEdition ? "Read the available instrument report with supporting observations, counterpoints and source dates in view." : "Independent interpretation of economic observations, company filings and reported futures positioning. One published edition, open to everyone."
            : workspace
              ? "The latest completed session and technical context, with the source data in view."
              : "Bring price action, news and original research into one considered view. Follow the evidence. See both sides.")}
      </p>
      {!publicEdition && !research && workspace && (
        <ObservedMarketContext workspace={workspace} />
      )}
      {!publicEdition && !research && !workspace && (
        <div className="brief-evidence">
          <span>
            <Check size={14} />
            {availableBars} price observations
          </span>
          <span>
            <Check size={14} />
            {availableNews} source-linked articles
          </span>
          <span>
            <Scale size={14} />
            Supporting & opposing views
          </span>
        </div>
      )}
      {research && (
        <div className="brief-findings">
          {(
            [
              ["Supporting view", research.bull, "supporting"],
              ["Counterpoints", research.bear, "opposing"],
              ["What to watch", research.watch, "watch"],
            ] as const
          ).map(([title, entries, style]) => (
            <div className={`brief-finding-group ${style}`} key={title}>
              <h3>
                <span />
                {title}
              </h3>
              {entries.length ? (
                <ul>
                  {entries.map((entry, i) => (
                    <li key={i}>
                      <p>{entry.text}</p>
                      {entry.sourceIds.length > 0 && (
                        <div className="citation-links">
                          {entry.sourceIds.map((id) => {
                            const source = sources.find(
                              (item) => item.id === id,
                            );
                            return source ? (
                              <ExternalLink
                                key={id}
                                href={source.url}
                                className="citation-link"
                              >
                                {source.title}
                              </ExternalLink>
                            ) : (
                              <span className="citation-link" key={id}>
                                Source {id} unavailable
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No supported observation was returned.</p>
              )}
            </div>
          ))}
        </div>
      )}
      {research && research.limitations.length > 0 && (
        <details className="brief-limitations">
          <summary>
            <CircleHelp size={15} />
            Limitations & missing evidence <ChevronRight size={15} />
          </summary>
          <ul>
            {research.limitations.map((limit, i) => (
              <li key={i}>{limit}</li>
            ))}
            {clockSources.map(clock => (
              <li key={clock.id}>Publication time: <ExternalLink href={clock.url}>{clock.name}</ExternalLink></li>
            ))}
          </ul>
        </details>
      )}
      {visibleBrief?.message && <Notice>{publicEdition ? publicationNotice(visibleBrief.message) : visibleBrief.message}</Notice>}
      <div className="brief-footer">
        <button
          className="button button-primary"
          onClick={onGenerate}
          disabled={
            busy ||
            (!publicEdition &&
              (!workspace || (availableBars === 0 && availableNews === 0)))
          }
        >
          {busy ? (
            <>
              <span className="spinner" />
              {publicEdition
                ? instrumentEdition ? "Loading the published report…" : "Loading the published brief…"
                : "Reading the evidence…"}
            </>
          ) : (
            <>
              {publicEdition ? <BookOpen size={15} /> : <Sparkles size={15} />}
              {publicEdition
                ? unavailableEdition ? "Check for a published report" : instrumentEdition ? "Read latest published report" : "Read latest published brief"
                : research
                  ? "Refresh the brief"
                  : "Build my research brief"}
              <ArrowRight size={15} />
            </>
          )}
        </button>
        <span>
          {publicEdition
            ? unavailableEdition ? "No saved report available" : instrumentEdition ? "Instrument edition" : "Market-wide edition"
            : research
              ? `Generated ${timestamp(brief?.createdAt)}${brief?.model ? ` · ${brief.model}` : ""}`
              : "Optional AI synthesis · Source-linked"}
        </span>
      </div>
    </section>
  );
}
