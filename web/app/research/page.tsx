import { archiveDisplayTitle } from "@/lib/archive-title";
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BookOpen } from 'lucide-react';
import { archiveArticles, archiveDate, archivePath } from '@/lib/archive';
import styles from './archive.module.css';
import PublicationHeader from '@/components/PublicationHeader';

export const metadata: Metadata = {
  title: 'Research Archive | The Daily Consensus',
  description: 'Read the original Daily Consensus archive: 58 articles from 2023 and 2025, preserved with original publication dates, attribution, charts, and source links. Free to everyone.',
  alternates: { canonical: '/research' },
};

export default function ResearchArchivePage() {
  const articles = archiveArticles();
  const years = [...new Set(articles.map((article) => article.publishedAt.slice(0, 4)))];
  return <div className={styles.page}>
    <a href="#archive" className="skip-link">Skip to research archive</a>
    <PublicationHeader active="archive" />
    <main id="archive" className={styles.main}>
      <div className={styles.intro}>
        <p className={styles.eyebrow}><BookOpen size={15} aria-hidden="true" /> Free public research</p>
        <h1>The research archive.</h1>
        <p className={styles.description}>The ideas, observations, and market conversations that started The Daily Consensus. {articles.length} original articles, open to everyone.</p>
        <p className={styles.context}>These articles retain their original publication dates and views. They are historical material, not current market analysis. Prices and forecasts have not been updated or verified against later outcomes.</p>
        <nav className={styles.yearNav} aria-label="Browse archive by year">{years.map((year) => <a href={`#year-${year}`} key={year}>{year}<span>{articles.filter((item) => item.publishedAt.startsWith(year)).length} articles</span></a>)}</nav>
      </div>
      {years.map((year) => <section key={year} id={`year-${year}`} className={styles.yearSection} aria-labelledby={`heading-${year}`}>
        <div className={styles.yearHeading}><h2 id={`heading-${year}`}>{year}</h2><span>{articles.filter((item) => item.publishedAt.startsWith(year)).length} archived articles</span></div>
        <div className={styles.articleList}>{articles.filter((item) => item.publishedAt.startsWith(year)).map((article) => <article key={article.id} className={styles.article}>
          <div className={styles.meta}><time dateTime={article.publishedAt}>{archiveDate(article.publishedAt)}</time><span>{article.publisher} · {article.readingMinutes} min read</span></div>
          <div className={styles.articleInfo}><Link href={archivePath(article.id)} className={styles.articleLink}><h3>{archiveDisplayTitle(article)}</h3><ArrowRight size={18} aria-hidden="true" /></Link><p>{article.excerpt}</p><span className={styles.author}>{article.author}</span></div>
        </article>)}</div>
      </section>)}
    </main>
    <footer className={styles.footer}><Link href="/research-desk">Return to the research desk <ArrowRight size={14} aria-hidden="true" /></Link><span>Research, open to everyone.</span></footer>
  </div>;
}
