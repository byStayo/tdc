import Link from 'next/link';
import styles from './PublicationFooter.module.css';

export default function PublicationFooter() {
  return <footer className={styles.footer}>
    <div className={styles.brand}><Link href="/">The Daily Consensus</Link><span>Independent research. Open to everyone.</span></div>
    <p>Research context, not personalized investment advice. Data can be delayed or revised. Missing signals remain visible.</p>
    <Link href="/methodology" className={styles.method}>Sources & methodology</Link>
  </footer>;
}
