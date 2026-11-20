"use client";

import { useState, type ReactNode } from "react";
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
  return (
    <details
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
