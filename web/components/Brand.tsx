import styles from "./Brand.module.css";

export default function Brand({
  label = "The Daily Consensus home",
}: {
  label?: string;
}) {
  return (
    <a href="/" aria-label={label} className={styles.brand}>
      <svg
        viewBox="0 0 32 36"
        width="32"
        height="36"
        aria-hidden="true"
        className={styles.mark}
      >
        <path d="M3 13v14M11 7v24M19 3v30M27 10v18" />
      </svg>
      <span className={styles.wordmark}>
        <span className={styles.prefix}>the daily</span>
        <strong>
          consensus<span className={styles.period}>.</span>
        </strong>
      </span>
    </a>
  );
}
