"use client";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  CircleHelp,
  Database,
  LayoutDashboard,
  Newspaper,
  ShieldCheck,
  Star,
} from "lucide-react";

export const NAVIGATION = [
  {
    id: "brief",
    label: "Daily Brief",
    icon: LayoutDashboard,
    group: "FREE MARKET RESEARCH",
  },
  { id: "market", label: "Market & technical", icon: Activity },
  { id: "positioning", label: "Positioning", icon: BarChart3 },
  { id: "news", label: "News & filings", icon: Newspaper },
  {
    id: "archive",
    label: "Research archive",
    icon: BookOpen,
    group: "YOUR RESEARCH",
  },
  { id: "watchlist", label: "Watchlist", icon: Star },
  { id: "sources", label: "Sources & methodology", icon: Database },
] as const;
export type View = (typeof NAVIGATION)[number]["id"];
function Brand() {
  return (
    <div className="brand">
      <span className="brand-symbol" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>
        the daily
        <br />
        <strong>
          consensus<span className="brand-period">.</span>
        </strong>
      </span>
    </div>
  );
}

export default function Navigation({
  view,
  onNavigate,
}: {
  view: View;
  onNavigate: (next: View) => void;
}) {
  return (
    <>
      <Brand />
      <nav aria-label="Main navigation">
        {NAVIGATION.map((item) => (
          <div key={item.id}>
            {"group" in item && <p className="nav-group">{item.group}</p>}
            <button
              className={`nav-item ${view === item.id ? "active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <item.icon size={17} strokeWidth={1.7} />
              <span>{item.label}</span>
              {view === item.id && <span className="nav-active-dot" />}
            </button>
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-note">
          <span className="small-logo">
            <ShieldCheck size={17} />
          </span>
          <p>
            Independent thinking.
            <br />
            <strong>Free for every reader.</strong>
          </p>
        </div>
        <button
          className="sidebar-method"
          onClick={() => onNavigate("sources")}
        >
          <CircleHelp size={14} />
          How to read the data
          <ArrowUpRight size={13} />
        </button>
        <span className="sidebar-copyright">No account. No paywall.</span>
      </div>
    </>
  );
}
