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
