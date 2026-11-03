import type { ReactNode } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Database,
  Info,
} from "lucide-react";
import type { DataStatus, Envelope, Quote } from "@/lib/contracts";

export function number(value: number | null | undefined, digits = 2): string {
  return value != null && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value)
    : "—";
}

export function compactNumber(value: number | null | undefined): string {
  return value != null && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value)
    : "—";
}

export function dateLabel(
  value: string | null | undefined,
  short = false,
): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(short ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(date);
}

export function timestamp(value: string | null | undefined): string {
  if (!value) return "Time unavailable";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateLabel(value);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function localDateLabel(value: string | null | undefined): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function safeUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\/research\/[A-Za-z0-9][A-Za-z0-9._~-]*\/?$/.test(value)) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const statusLabels: Record<DataStatus, string> = {
  ok: "Connected",
  partial: "Partial coverage",
  unavailable: "Unavailable",
  unconfigured: "Not connected",
  unauthorized: "Access required",
  rate_limited: "Rate limited",
  stale: "Older data",
};

export function StatusBadge({
  status,
  label,
}: {
  status?: DataStatus;
  label?: string;
}) {
  return (
    <span className={`status-badge status-${status ?? "pending"}`}>
      <span className="status-dot" />
      {label ?? (status ? statusLabels[status] : "Awaiting data")}
    </span>
  );
}

export function SourceNote({
  envelope,
}: {
  envelope?: Pick<
    Envelope<unknown>,
    "source" | "asOf" | "status" | "coverage" | "message"
  >;
}) {
  if (!envelope)
    return (
      <p className="source-note">
        <Database size={12} />
        Source information will appear with the data.
      </p>
    );
  return (
    <div className="source-note">
      <Database size={12} />
      <span>
        {envelope.source}
        {envelope.asOf ? ` · As of ${timestamp(envelope.asOf)}` : ""}
        {envelope.coverage ? ` · ${envelope.coverage}` : ""}
      </span>
    </div>
  );
}

export function ExternalLink({
  href,
  children,
  className = "",
}: {
  href: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const url = safeUrl(href);
  const internal = url?.startsWith("/research/");
  return url ? (
    <a
      href={url}
      className={className}
      target={internal ? undefined : "_blank"}
      rel={internal ? undefined : "noopener noreferrer"}
    >
      {children}
      {internal ? (
        <ArrowRight size={14} aria-hidden="true" />
      ) : (
        <ArrowUpRight size={14} aria-hidden="true" />
      )}
      {!internal && <span className="sr-only"> (opens in a new tab)</span>}
    </a>
  ) : (
    <span className={className}>{children}</span>
  );
}

export function EmptyState({
  title,
  children,
  loading = false,
}: {
  title: string;
  children: ReactNode;
  loading?: boolean;
}) {
  return (
    <div
      className={`empty-state ${loading ? "is-loading" : ""}`}
      role={loading ? "status" : undefined}
    >
      <span className="empty-icon">
        {loading ? (
          <span className="spinner" />
        ) : (
          <Database size={20} strokeWidth={1.5} />
        )}
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function PanelHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="panel-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
      </div>
      {children}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <Info size={15} aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

export function QuoteChange({ quote }: { quote?: Quote }) {
  if (quote?.changePercent == null)
    return <span className="quote-unavailable">Change unavailable</span>;
  const positive = quote.changePercent >= 0;
  return (
    <span className={`quote-change ${positive ? "positive" : "negative"}`}>
      {positive ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
      {positive ? "+" : ""}
      {number(quote.changePercent)}%
    </span>
  );
}
