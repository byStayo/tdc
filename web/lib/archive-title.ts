// Three recovered titles contain a leading sentence fragment. Only these exact
// prefixes are omitted in presentation; the original archive record is intact.
const fragments: Record<string, string> = {
  "wordpress-483": "knell for employers if not managed properly. ",
  "wordpress-480": "precedent. ",
  "wordpress-478": "other economic and political pressures. ",
};

export function archiveDisplayTitle(article: { id: string; title: string }): string {
  const fragment = fragments[article.id];
  return fragment && article.title.startsWith(fragment) && article.title.length > fragment.length
    ? article.title.slice(fragment.length)
    : article.title;
}
