import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowUpRight, BookOpen, ChevronRight } from 'lucide-react';
import {
  archiveArticle, archiveArticles, archiveDate, archivePath,
  localArchiveLink, relatedArchiveArticles, safeArchiveMediaUrl, safeArchiveUrl,
  type ArchiveBlock, type ArchiveInline,
} from '@/lib/archive';
import styles from './article.module.css';

type Props = { params: Promise<{ id: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return archiveArticles().map(({ id }) => ({ id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const article = archiveArticle(id);
  if (!article) notFound();
  const description = `From the archive, ${archiveDate(article.publishedAt)}. ${article.excerpt}`;
  return {
    title: `${article.title} | The Daily Consensus Archive`,
    description,
    authors: [{ name: article.author }],
    alternates: { canonical: archivePath(article.id) },
    openGraph: {
      type: 'article', title: article.title, description,
      siteName: 'The Daily Consensus', publishedTime: article.publishedAt,
      authors: [article.author],
    },
  };
}

function InlineContent({ nodes }: { nodes: ArchiveInline[] }) {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text': return node.text;
      case 'break': return <br key={index} />;
      case 'strong': return <strong key={index}><InlineContent nodes={node.children} /></strong>;
      case 'em': return <em key={index}><InlineContent nodes={node.children} /></em>;
      case 'code': return <code key={index}><InlineContent nodes={node.children} /></code>;
      case 'link': {
        const href = safeArchiveUrl(node.href);
        const local = href && localArchiveLink(href);
        if (local) return <Link key={index} href={local}><InlineContent nodes={node.children} /></Link>;
        return href
          ? <a key={index} href={href} target="_blank" rel="noopener noreferrer"><InlineContent nodes={node.children} /><span className="sr-only"> (opens in a new tab)</span></a>
          : <span key={index}><InlineContent nodes={node.children} /></span>;
      }
    }
  });
}

function ArticleBlocks({ blocks }: { blocks: ArchiveBlock[] }) {
  return blocks.map((block, index) => {
    switch (block.type) {
      case 'paragraph': return <p key={index}><InlineContent nodes={block.children} /></p>;
      case 'heading': {
        const Heading = `h${block.level}` as 'h2' | 'h3' | 'h4';
        return <Heading key={index}><InlineContent nodes={block.children} /></Heading>;
      }
      case 'rule': return <hr key={index} />;
      case 'quote': return <blockquote key={index}><ArticleBlocks blocks={block.blocks} /></blockquote>;
      case 'list': {
        const List = block.ordered ? 'ol' : 'ul';
        return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><ArticleBlocks blocks={item} /></li>)}</List>;
      }
      case 'image': {
        const src = safeArchiveMediaUrl(block.src);
        const source = safeArchiveUrl(block.sourceUrl);
        if (!src) return null;
        return <figure key={index}>
          <a href={src} target="_blank" rel="noopener noreferrer" className={styles.figureLink}>
            {/* Original public figures are copied locally with source provenance. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={block.alt || 'Original figure accompanying this article'} width={block.width} height={block.height} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
            <span className="sr-only">Open original image in a new tab</span>
          </a>
          <figcaption>
            {block.caption.length > 0 && <span><InlineContent nodes={block.caption} /></span>}
            {source && <a href={source} target="_blank" rel="noopener noreferrer" className={styles.imageSource}>Original image source<span className="sr-only"> (opens in a new tab)</span></a>}
            {block.mediaStatus === 'external' && <span className={styles.externalImageNote}>This image remains hosted by the original source.</span>}
          </figcaption>
        </figure>;
      }
    }
  });
}

export default async function ArchiveArticlePage({ params }: Props) {
  const { id } = await params;
  const article = archiveArticle(id);
  if (!article) notFound();
  const related = relatedArchiveArticles(article);

  return <div className={styles.page}>
    <a href="#article" className="skip-link">Skip to article</a>
    <header className={styles.siteHeader}>
      <Link href="/" className={styles.brand} aria-label="The Daily Consensus home"><span className={styles.brandMark}>DC</span><span>The Daily Consensus<small>Free public research</small></span></Link>
      <Link href="/research-desk" className={styles.homeLink}>Research desk <ArrowUpRight size={16} aria-hidden="true" /></Link>
    </header>
    <main className={styles.main}>
      <Link href="/research" className={styles.backLink}><ArrowLeft size={15} aria-hidden="true" /> Research archive</Link>
      <article id="article" className={styles.article}>
        <header className={styles.articleHeader}>
          <p className={styles.eyebrow}><BookOpen size={14} aria-hidden="true" /> From the archive · {article.publisher}</p>
          <h1>{article.title}</h1>
          <div className={styles.byline}><span>{article.author}</span><span aria-hidden="true">·</span><time dateTime={article.publishedAt}>{archiveDate(article.publishedAt)}</time><span aria-hidden="true">·</span><span>{article.readingMinutes} min read</span></div>
        </header>
        <aside className={styles.archiveNotice} aria-label="Historical article context">
          <strong>Published {archiveDate(article.publishedAt)}</strong>
          <p>This article is preserved from the original Daily Consensus archive. Prices, events, opinions, and forecasts reflect that date. It has not been updated or verified against later outcomes and is not current investment guidance.</p>
        </aside>
        <div className={styles.body}><ArticleBlocks blocks={article.blocks} /></div>
        <footer className={styles.articleFooter}>
          <p>Originally published on {article.publisher}. Article text, attribution, and original figures have been preserved with their source links; subscription widgets have been removed.</p>
          <a href={article.sourceUrl} target="_blank" rel="noopener noreferrer">View original publication <ArrowUpRight size={15} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
        </footer>
      </article>
      <section className={styles.related} aria-labelledby="more-archive">
        <div className={styles.relatedHeading}><h2 id="more-archive">More from the archive</h2><Link href="/research">All {archiveArticles().length} articles <ChevronRight size={15} aria-hidden="true" /></Link></div>
        <div className={styles.relatedGrid}>{related.map((item) => <Link href={archivePath(item.id)} key={item.id} className={styles.relatedCard}>
          <time dateTime={item.publishedAt}>{archiveDate(item.publishedAt)}</time>
          <h3>{item.title}</h3>
          <span>Read archived article <ArrowUpRight size={15} aria-hidden="true" /></span>
        </Link>)}</div>
      </section>
    </main>
    <footer className={styles.siteFooter}><Link href="/">The Daily Consensus</Link><span>Research, open to everyone.</span></footer>
  </div>;
}
