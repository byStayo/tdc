export const X_POST_FIELDS = "author_id,created_at,lang,referenced_tweets,withheld,note_tweet";
export const X_POST_TEXT_METHOD = "x-api-note-tweet-v1";
const maxNoteCharacters = 25_000;

export function xPostText(post: Record<string, unknown>): string | null {
  if (!Object.hasOwn(post, "note_tweet")) {
    const text = post.text;
    return typeof text === "string" && text.length <= 12_000 && text.trim() ? text : null;
  }
  // When a note is advertised, its ordinary text can be a truncated preview.
  const note = post.note_tweet;
  if (!note || typeof note !== "object" || Array.isArray(note) || !("text" in note)) return null;
  return xLongPostText(note.text);
}

export function xLongPostText(text: unknown): string | null {
  if (typeof text !== "string" || text.length > 2 * maxNoteCharacters || !text.isWellFormed()) return null;
  if (text.length > maxNoteCharacters && [...text].length > maxNoteCharacters) return null;
  return text.trim() ? text : null;
}

// These are display characters found in native X exports or needed for their quotation,
// question and negation guards. Keep original text intact for provenance and annotation.
const displayEntities: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ldquo: "“", rdquo: "”",
  lsquo: "‘", rsquo: "’", quest: "?", nbsp: "\u00a0",
};
const numericDisplayEntities = new Map(
  Object.values(displayEntities).map(character => [character.codePointAt(0)!, character]),
);
const displayEntity = /&(amp|lt|gt|quot|apos|ldquo|rdquo|lsquo|rsquo|quest|nbsp|#(?:[0-9]{1,7}|x[0-9a-f]{1,6}));/gi;

export function xDisplayText(original: string): string {
  let text = original;
  for (let depth = 0; depth < 3 && text.includes("&"); depth++) {
    const decoded = text.replace(displayEntity, (match, name: string) => {
      const key = name.toLowerCase();
      if (!key.startsWith("#")) return displayEntities[key];
      const hexadecimal = key.startsWith("#x");
      const number = Number.parseInt(key.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return numericDisplayEntities.get(number) ?? match;
    });
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}
