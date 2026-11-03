import type { MetadataRoute } from 'next';
import { archiveArticles, archivePath } from '@/lib/archive';
import { siteUrl } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, changeFrequency: 'daily', priority: 1 },
    { url: `${siteUrl}/research`, changeFrequency: 'weekly', priority: 0.7 },
    ...archiveArticles().map(article => ({ url: `${siteUrl}${archivePath(article.id)}`, changeFrequency: 'yearly' as const, priority: 0.5 })),
  ];
}
