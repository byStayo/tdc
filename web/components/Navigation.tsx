"use client";
import Brand from "./Brand";
import {
  Activity,
  ArrowRight,
  BarChart3,
  BookOpen,
  CircleHelp,
  Database,
  FileText,
  LayoutDashboard,
  Newspaper,
  ShieldCheck,
  Star,
  Coffee,
} from "lucide-react";

export const NAVIGATION = [
  {
    id: "brief",
    label: "Daily Brief",
    icon: LayoutDashboard,
    group: "FREE MARKET RESEARCH",
  },
  { id: "reports", label: "Instrument reports", icon: FileText },
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

export default function Navigation({
  view,
  onNavigate,
}: {
  view: View;
  onNavigate: (next: View) => void;
}) {
  return (
    <>
      <div className="brand">
        <Brand label="The Daily Consensus morning overview" />
      </div>
      <nav aria-label="Main navigation">
        <a className="nav-item" href="/"><Coffee size={17} strokeWidth={1.7} /><span>Morning view</span></a>
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
          <ArrowRight size={13} />
        </button>
      </div>
    </>
  );
}
