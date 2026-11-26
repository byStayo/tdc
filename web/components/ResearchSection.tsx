"use client";

import { useCallback, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import styles from "./MorningBoard.module.css";

export default function ResearchSection({
  number,
  title,
  description,
  children,
}: {
  number: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // The browser can open the native disclosure before React attaches onToggle.
  const readInitialOpen = useCallback((section: HTMLDetailsElement | null) => {
    if (section) setOpen(section.open);
  }, []);
  return (
    <details
      ref={readInitialOpen}
      className={styles.researchSection}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={styles.researchNumber}>{number}</span>
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <Plus size={20} aria-hidden="true" />
      </summary>
      {open && <div className={styles.researchContents}>{children}</div>}
    </details>
  );
}
