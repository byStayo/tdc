"use client";

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
}: {
  symbol: string;
  workspace: Workspace | null;
  brief: ResearchResponse | null;
  busy: boolean;
  onGenerate: () => void;
  publicEdition?: boolean;
}) {
  const availableNews = workspace?.news.data.length ?? 0;
  const availableBars = workspace?.history.data.length ?? 0;
  const sources = brief?.sources ?? [];
  const research = brief?.data;
  return (
    <section
      className={`brief-panel ${research ? "has-research" : ""}`}
      aria-label={
        publicEdition
          ? "Latest published market research"
          : "Daily market context and optional AI research"
      }
    >
      <p className="sr-only" role="status" aria-live="polite">
        {busy
          ? publicEdition
            ? "Loading the latest published market brief."
            : "Reading the evidence and preparing your brief."
          : research
            ? "Your research brief is ready."
            : (brief?.message ?? "Build a brief when you are ready.")}
      </p>
      <div className="brief-topline">
        <span className="eyebrow">
          <span className="brief-mark" />
          <span>
            {publicEdition
              ? "THE DAILY CONSENSUS · PUBLISHED BRIEF"
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
            ? "Free for all readers"
            : research
              ? "AI-assisted research"
              : "Market observations"}
        </span>
      </div>
      <h2>
        {research?.headline ??
          (publicEdition
            ? "Markets, in perspective."
            : `A clearer view of ${symbol}.`)}
      </h2>
      {publicEdition && (
        <p className="published-edition-meta">
          Market-wide research
          {brief?.createdAt
            ? ` · Published ${timestamp(brief.createdAt)}`
            : " · Latest edition"}
        </p>
      )}
      <p className="brief-summary">
        {research?.summary ??
          (publicEdition
            ? "Independent interpretation of economic observations, company filings and reported futures positioning. One published edition, open to everyone."
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
          </ul>
        </details>
      )}
      {brief?.message && <Notice>{brief.message}</Notice>}
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
                ? "Loading the published brief…"
                : "Reading the evidence…"}
            </>
          ) : (
            <>
              {publicEdition ? <BookOpen size={15} /> : <Sparkles size={15} />}
              {publicEdition
                ? "Read latest published brief"
                : research
                  ? "Refresh the brief"
                  : "Build my research brief"}
              <ArrowRight size={15} />
            </>
          )}
        </button>
        <span>
          {publicEdition
            ? "Market-wide edition · No account or payment required"
            : research
              ? `Generated ${timestamp(brief?.createdAt)}${brief?.model ? ` · ${brief.model}` : ""}`
              : "Optional AI synthesis · Source-linked"}
        </span>
      </div>
    </section>
  );
}
