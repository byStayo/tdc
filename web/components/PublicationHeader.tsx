"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Moon, Sun } from "lucide-react";
import Brand from "./Brand";
import styles from "./PublicationHeader.module.css";

type Theme = "dark" | "light";
const links = [
  { id: "morning", href: "/", label: "Morning view" },
  { id: "desk", href: "/research-desk", label: "Research desk" },
  { id: "archive", href: "/research", label: "Archive" },
  { id: "methodology", href: "/methodology", label: "Methodology" },
] as const;

export default function PublicationHeader({ active, theme: controlledTheme, onToggleTheme }: {
  active: (typeof links)[number]["id"];
  theme?: Theme;
  onToggleTheme?: () => void;
}) {
  const [savedTheme, setSavedTheme] = useState<Theme>("dark");
  useEffect(() => {
    setSavedTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const theme = controlledTheme ?? savedTheme;
  function toggleTheme() {
    if (onToggleTheme) { onToggleTheme(); return; }
    const next = theme === "dark" ? "light" : "dark";
    setSavedTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("tdc-theme", next); } catch { /* Usable for this visit. */ }
  }
  return <header className={styles.header}>
    <Brand />
    <nav className={styles.navigation} aria-label="Primary">
      {links.map(link => <Link key={link.id} href={link.href} aria-current={active === link.id ? "page" : undefined}>{link.label}</Link>)}
    </nav>
    <button className={styles.themeButton} onClick={toggleTheme}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
      {theme === "dark" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </button>
  </header>;
}
