export function instagramCaptionText(caption: unknown): string | null {
  if (typeof caption !== "string" || !caption.trim() || caption.length > 12_000) return null;
  return caption.replace(/(^|\s)#(SPY|QQQ|IWM|DIA|TLT)\b/gi, (_match, space, symbol) => space + "$" + symbol);
}
