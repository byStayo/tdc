#!/usr/bin/env python3
"""Import the recovered public archive as safe, typed content blocks.

Run from anywhere with Python 3.10+ (standard library only):
  python3 scripts/import-archive.py
  python3 scripts/import-archive.py --download-media
  python3 scripts/import-archive.py --check
  python3 scripts/import-archive.py --self-test

The private recovery directory is only an input. Only article text, attribution,
publication dates, and public media/source links enter the generated JSON. No raw
HTML, subscription widgets, forms, scripts, or arbitrary attributes are retained.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
import hashlib
import json
import math
from pathlib import Path
import re
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

WEB_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RECOVERY = WEB_ROOT.parents[1] / "recovery"
OUTPUT = WEB_ROOT / "lib/archive-content.json"
MEDIA_DIR = WEB_ROOT / "public/archive-media"
MEDIA_MANIFEST = MEDIA_DIR / "manifest.json"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MEDIA_HOSTS = {"substackcdn.com", "substack-post-media.s3.amazonaws.com", "images.unsplash.com"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
DROP_TAGS = {"script", "style", "noscript", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "svg", "canvas", "template", "audio", "video"}
DROP_CLASSES = {"subscription-widget-wrap-editor", "subscription-widget", "button-wrapper", "image-link-expand", "fake-input-wrapper"}
BLOCK_TAGS = {"p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "figure", "img", "hr"}


@dataclass
class Element:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list = field(default_factory=list)


class Document(HTMLParser):
    def __init__(self, source: str):
        super().__init__(convert_charrefs=True)
        self.root = Element("root")
        self.stack = [self.root]
        self.feed(source)
        self.close()

    def handle_starttag(self, tag, attrs):
        element = Element(tag, {key: value or "" for key, value in attrs})
        self.stack[-1].children.append(element)
        if tag not in VOID_TAGS:
            self.stack.append(element)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack = self.stack[:index]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def discard(node: Element) -> bool:
    return node.tag in DROP_TAGS or bool(set(node.attrs.get("class", "").split()) & DROP_CLASSES)


def descendants(node: Element, tag: str):
    if discard(node):
        return
    for child in node.children:
        if isinstance(child, Element):
            if child.tag == tag and not discard(child):
                yield child
            yield from descendants(child, tag)


def safe_url(value: str | None, source_url: str) -> str | None:
    if not value or re.search(r"[\x00-\x20\x7f]", value.strip()):
        return None
    try:
        url = urlsplit(urljoin(source_url, value.strip()))
        if url.scheme not in {"https", "http"} or not url.hostname or url.username or url.password:
            return None
        # Validate malformed ports too; no arbitrary browser URL schemes survive.
        _ = url.port
        query = [(key, val) for key, val in parse_qsl(url.query, keep_blank_values=True)
                 if not key.lower().startswith("utm_") and key.lower() not in {"fbclid", "gclid", "mc_cid", "mc_eid"}]
        return urlunsplit((url.scheme, url.netloc, url.path, urlencode(query), url.fragment))
    except ValueError:
        return None


def inline_text(nodes: list[dict]) -> str:
    return "".join(node.get("text", "\n" if node["type"] == "break" else inline_text(node.get("children", []))) for node in nodes)


def compact_inline(nodes: list[dict]) -> list[dict]:
    result = []
    for node in nodes:
        if node["type"] == "text" and not node["text"]:
            continue
        if result and result[-1]["type"] == node["type"] == "text":
            result[-1]["text"] += node["text"]
        else:
            result.append(node)
    return result


class Importer:
    def __init__(self, html: str, source_url: str):
        self.root = Document(html).root
        self.source_url = source_url
        headings = [int(tag[1]) for tag in (f"h{level}" for level in range(1, 7)) if next(descendants(self.root, tag), None)]
        self.heading_offset = 2 - min(headings) if headings else 0

    def inline(self, nodes: list) -> list[dict]:
        result = []
        for node in nodes:
            if isinstance(node, str):
                result.append({"type": "text", "text": re.sub(r"\s+", " ", node)})
                continue
            if discard(node):
                continue
            if node.tag == "br":
                result.append({"type": "break"})
                continue
            children = self.inline(node.children)
            if not children:
                continue
            if node.tag in {"strong", "b", "em", "i", "code"}:
                kind = {"b": "strong", "i": "em"}.get(node.tag, node.tag)
                result.append({"type": kind, "children": children})
            elif node.tag == "a" and (href := safe_url(node.attrs.get("href"), self.source_url)):
                result.append({"type": "link", "href": href, "children": children})
            else:
                result.extend(children)
        return compact_inline(result)

    def image(self, node: Element, caption: list[dict] | None = None) -> dict | None:
        src = safe_url(node.attrs.get("src"), self.source_url)
        if not src:
            return None
        # Ignore invisible tracking pixels, while retaining original public figures.
        dimensions = {}
        for key in ("width", "height"):
            value = node.attrs.get(key, "")
            if re.fullmatch(r"\d{1,5}", value) and 0 < int(value) <= 20000:
                dimensions[key] = int(value)
        if any(value <= 1 for value in dimensions.values()):
            return None
        return {"type": "image", "src": src, "sourceUrl": src, "mediaStatus": "external", "alt": node.attrs.get("alt", ""),
                "caption": caption or [], **dimensions}

    def blocks(self, nodes: list) -> list[dict]:
        result, pending = [], []

        def flush():
            children = self.inline(pending)
            if inline_text(children).strip():
                result.append({"type": "paragraph", "children": children})
            pending.clear()

        for node in nodes:
            if isinstance(node, str):
                pending.append(node)
                continue
            if discard(node):
                continue
            if node.tag not in BLOCK_TAGS:
                pending.append(node)
                continue
            flush()
            if node.tag == "p":
                children = self.inline(node.children)
                if inline_text(children).strip():
                    result.append({"type": "paragraph", "children": children})
            elif re.fullmatch(r"h[1-6]", node.tag):
                children = self.inline(node.children)
                if inline_text(children).strip():
                    level = max(2, min(4, int(node.tag[1]) + self.heading_offset))
                    result.append({"type": "heading", "level": level, "children": children})
            elif node.tag in {"ul", "ol"}:
                items = [self.blocks(child.children) for child in node.children
                         if isinstance(child, Element) and child.tag == "li" and not discard(child)]
                items = [item for item in items if item]
                if items:
                    result.append({"type": "list", "ordered": node.tag == "ol", "items": items})
            elif node.tag == "blockquote":
                children = self.blocks(node.children)
                if children:
                    result.append({"type": "quote", "blocks": children})
            elif node.tag == "figure":
                caption_node = next(descendants(node, "figcaption"), None)
                caption = self.inline(caption_node.children) if caption_node else []
                for index, img in enumerate(descendants(node, "img")):
                    if block := self.image(img, caption if index == 0 else []):
                        result.append(block)
            elif node.tag == "img":
                if block := self.image(node):
                    result.append(block)
            elif node.tag == "hr":
                if not result or result[-1]["type"] != "rule":
                    result.append({"type": "rule"})
            else:
                result.extend(self.blocks(node.children))
        flush()
        return result

    def convert(self):
        return self.blocks(self.root.children)


def text_of_blocks(blocks: list[dict]) -> str:
    sections = []
    for block in blocks:
        if block["type"] in {"paragraph", "heading"}:
            sections.append(inline_text(block["children"]))
        elif block["type"] == "image":
            sections.append(inline_text(block["caption"]))
        elif block["type"] == "quote":
            sections.append(text_of_blocks(block["blocks"]))
        elif block["type"] == "list":
            sections.extend(text_of_blocks(item) for item in block["items"])
    return "\n".join(sections)


def all_blocks(blocks):
    for block in blocks:
        yield block
        if block["type"] == "quote":
            yield from all_blocks(block["blocks"])
        elif block["type"] == "list":
            for item in block["items"]:
                yield from all_blocks(item)


def plain_html(html: str) -> str:
    return re.sub(r"\s+", " ", text_of_blocks(Importer(html, "https://thedailyconsensus.com/").convert())).strip()


def wp_author(post: dict) -> str:
    # This is public attribution from the original post, not an inferred identity.
    head = Document(post.get("aioseo_head", "")).root
    for node in descendants(head, "meta"):
        if node.attrs.get("name", "").lower() == "author" and node.attrs.get("content"):
            return node.attrs["content"]
    return "The Daily Consensus"


def article(article_id, title, source_url, published_at, author, publisher, html, excerpt):
    url = safe_url(source_url, source_url)
    if not url:
        raise ValueError(f"Invalid original source URL for {article_id}")
    blocks = Importer(html, url).convert()
    text = text_of_blocks(blocks)
    if not text.strip():
        raise ValueError(f"No article body recovered for {article_id}")
    return {"id": article_id, "title": plain_html(title), "excerpt": excerpt,
            "sourceUrl": url, "publishedAt": published_at, "author": author,
            "publisher": publisher, "readingMinutes": max(1, math.ceil(len(text.split()) / 220)),
            "blocks": blocks}


def import_archive(recovery: Path):
    wp = json.loads((recovery / "wordpress-posts.json").read_text())
    substack = json.loads((recovery / "substack-archive.json").read_text())
    metadata = json.loads((WEB_ROOT / "lib/research-archive.json").read_text())
    summaries = {item["id"]: item["excerpt"] for item in metadata}
    articles = []
    for post in wp:
        article_id = f"wordpress-{post['id']}"
        if post.get("status") != "publish" or post["content"].get("protected"):
            raise ValueError(f"Refusing non-public WordPress content: {article_id}")
        raw_date = post.get("date_gmt") or post["date"]
        published_at = datetime.fromisoformat(raw_date).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
        articles.append(article(article_id, post["title"]["rendered"], post["link"], published_at,
                                wp_author(post), "WordPress", post["content"]["rendered"], summaries[article_id]))
    for index, post in enumerate(substack):
        article_id = f"substack-{index}"
        published_at = parsedate_to_datetime(post["publishedAt"]).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        articles.append(article(article_id, post["title"], post["url"], published_at,
                                post.get("author") or "The Daily Consensus", "Substack", post["content"], summaries[article_id]))
    articles.sort(key=lambda item: (item["publishedAt"], item["id"]), reverse=True)
    ids = [item["id"] for item in articles]
    if len(ids) != len(set(ids)) or set(ids) != set(summaries):
        raise ValueError("Imported article IDs do not match the recovered metadata archive")
    if len(articles) != 58:
        raise ValueError(f"Expected 58 recovered public articles; found {len(articles)}")
    return articles


def media_type(data: bytes) -> tuple[str, str] | None:
    """Allow raster images only, checking bytes instead of trusting extensions."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "jpg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif", "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    if data[4:8] == b"ftyp" and data[8:12] in {b"avif", b"avis"}:
        return "image/avif", "avif"
    return None


def original_image_url(source_url: str) -> str:
    # Substack's published img URL wraps a public original. Prefer that exact
    # original to preserve full resolution, falling back to the published CDN.
    marker = source_url.find("/https%3A")
    if marker >= 0:
        candidate = unquote(source_url[marker + 1:])
        if urlsplit(candidate).hostname == "substack-post-media.s3.amazonaws.com":
            return candidate
    return source_url


def checked_media_path(local_path: str) -> Path:
    if not re.fullmatch(r"/archive-media/[a-f0-9]{64}\.(?:png|jpg|webp|gif|avif)", local_path):
        raise ValueError("Invalid local archive image path")
    return WEB_ROOT / "public" / local_path.lstrip("/")


def cached_media_valid(entry: dict) -> bool:
    if entry.get("status") != "downloaded":
        return False
    try:
        path = checked_media_path(entry["localPath"])
        data = path.read_bytes()
        return (0 < len(data) <= MAX_IMAGE_BYTES and len(data) == entry["bytes"]
                and hashlib.sha256(data).hexdigest() == entry["sha256"]
                and media_type(data)[0] == entry["contentType"])
    except (KeyError, OSError, TypeError, ValueError):
        return False


def fetch_image(source_url: str) -> dict:
    errors = []
    candidates = list(dict.fromkeys([original_image_url(source_url), source_url]))
    for candidate in candidates:
        try:
            if urlsplit(candidate).hostname not in MEDIA_HOSTS or not safe_url(candidate, candidate):
                raise ValueError("Image host is outside the recovered public media allowlist")
            request = Request(candidate, headers={"User-Agent": "TheDailyConsensus-ArchiveMigration/1.0", "Accept": "image/*"})
            with urlopen(request, timeout=25) as response:
                if urlsplit(response.url).hostname not in MEDIA_HOSTS:
                    raise ValueError("Image redirected outside the recovered public media allowlist")
                mime = response.headers.get_content_type()
                length = response.headers.get("Content-Length")
                if length and int(length) > MAX_IMAGE_BYTES:
                    raise ValueError("Image exceeds the 20 MiB per-file limit")
                data = response.read(MAX_IMAGE_BYTES + 1)
                if length and len(data) != int(length):
                    raise ValueError("Image download size does not match Content-Length")
                detected = media_type(data)
                if not data or len(data) > MAX_IMAGE_BYTES or not detected:
                    raise ValueError("Image is empty, oversized, or not an allowed raster image")
                if mime != detected[0]:
                    raise ValueError(f"Image MIME mismatch: declared {mime}, detected {detected[0]}")
                digest = hashlib.sha256(data).hexdigest()
                local_path = f"/archive-media/{digest}.{detected[1]}"
                checked_media_path(local_path).write_bytes(data)
                return {"sourceUrl": source_url, "downloadUrl": response.url, "localPath": local_path,
                        "status": "downloaded", "sha256": digest, "bytes": len(data), "contentType": mime,
                        "downloadedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
        except Exception as error:
            errors.append(f"{type(error).__name__}: {error}")
    return {"sourceUrl": source_url, "status": "failed", "errors": errors}


def archive_media(articles: list[dict], download: bool, check: bool):
    images = [(article["id"], block) for article in articles for block in all_blocks(article["blocks"]) if block["type"] == "image"]
    sources = list(dict.fromkeys(block["sourceUrl"] for _, block in images))
    previous = json.loads(MEDIA_MANIFEST.read_text()) if MEDIA_MANIFEST.exists() else {"assets": []}
    entries = {asset["sourceUrl"]: asset for asset in previous["assets"] if asset["sourceUrl"] in sources}
    if download:
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        pending = [source for source in sources if not cached_media_valid(entries.get(source, {}))]
        with ThreadPoolExecutor(max_workers=4) as workers:
            for entry in workers.map(fetch_image, pending):
                entries[entry["sourceUrl"]] = entry
        assets = []
        for source in sources:
            entry = entries[source]
            entry["articleIds"] = sorted({article_id for article_id, block in images if block["sourceUrl"] == source})
            assets.append(entry)
        manifest = {"version": 1, "imageReferences": len(images), "uniqueSourceUrls": len(sources),
                    "downloadedAssets": sum(item["status"] == "downloaded" for item in assets),
                    "failedAssets": sum(item["status"] == "failed" for item in assets),
                    "maxFileBytes": MAX_IMAGE_BYTES, "assets": assets}
        MEDIA_MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    for _, block in images:
        entry = entries.get(block["sourceUrl"], {})
        if entry.get("status") == "downloaded":
            if not cached_media_valid(entry):
                raise ValueError(f"Archive media is missing or differs from its manifest: {entry.get('localPath')}")
            block["src"] = entry["localPath"]
            block["mediaStatus"] = "local"
        elif check and MEDIA_MANIFEST.exists() and not entry:
            raise ValueError("An archived figure is missing from the media manifest")
    if MEDIA_MANIFEST.exists():
        successful = sum(block["mediaStatus"] == "local" for _, block in images)
        print(f"Archive media: {successful}/{len(images)} references stored locally; {len(images) - successful} remain external")
        for entry in entries.values():
            if entry.get("status") == "failed":
                print(f"MEDIA FAILURE: {entry['sourceUrl']} — {'; '.join(entry['errors'])}")


def self_test():
    base = "https://example.com/story"
    source = '''<h3>Heading</h3><p>Safe <strong>bold</strong> <a href="javascript:alert(1)">bad link</a> <a href="/source?utm_source=test&amp;x=2">source</a>.</p>
    <script>alert('bad')</script><div class="subscription-widget"><p>Remove subscriber UI</p></div>
    <p class="button-wrapper"><a href="/subscribe">Subscribe</a></p><form><input value="secret">form content</form>
    <blockquote><p>Quote</p><ul><li>One<ol><li><em>Nested two</em></li></ol></li></ul></blockquote>
    <figure><a href="/image"><picture><img src="https://images.example.com/chart.png" onerror="evil()" alt="Chart &amp; proof" width="800" height="600"></picture><button>Remove controls</button></a><figcaption>Credit <a href="https://example.com/credit">source</a></figcaption></figure>
    <img src="data:text/html,evil"><img src="/pixel" width="1" height="1"><iframe src="https://bad.example">embedded</iframe>'''
    blocks = Importer(source, base).convert()
    serialized = json.dumps(blocks)
    assert blocks[0] == {"type": "heading", "level": 2, "children": [{"type": "text", "text": "Heading"}]}
    assert all(value not in serialized for value in ["javascript:", "alert(", "onerror", "Remove", "secret", "Subscribe", "form content", "embedded", "data:text", "/pixel", "utm_source"])
    assert "https://example.com/source?x=2" in serialized
    assert "bad link" in serialized and "Nested two" in serialized
    images = [block for block in all_blocks(blocks) if block["type"] == "image"]
    assert len(images) == 1 and images[0]["alt"] == "Chart & proof"
    assert inline_text(images[0]["caption"]) == "Credit source"
    assert safe_url("https://name:password@example.com", base) is None
    assert safe_url("javascript:\nalert(1)", base) is None
    assert safe_url("//example.com/chart.png", base) == "https://example.com/chart.png"
    assert safe_url("https://example.com:invalid/a", base) is None
    # React receives text data, including angle brackets; never an HTML string.
    assert Importer('<p>&lt;script&gt;literal&lt;/script&gt;</p>', base).convert()[0]["children"][0]["text"] == "<script>literal</script>"
    assert Importer('<p>Before</p><div><hr></div><p>After</p>', base).convert()[1]["type"] == "rule"
    assert media_type(b'<svg onload="evil()">') is None
    assert media_type(b'<html>Error page</html>') is None
    assert media_type(b'\x89PNG\r\n\x1a\n') == ("image/png", "png")
    try:
        checked_media_path("/archive-media/../../secret")
        raise AssertionError("Unsafe local path was accepted")
    except ValueError:
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recovery-dir", type=Path, default=DEFAULT_RECOVERY)
    parser.add_argument("--check", action="store_true", help="Verify generated output matches source without writing")
    parser.add_argument("--download-media", action="store_true", help="Copy original public figures into the durable local media archive")
    parser.add_argument("--self-test", action="store_true", help="Run importer safety and preservation tests only")
    args = parser.parse_args()
    if args.check and args.download_media:
        parser.error("--check does not download or write; use --download-media separately")
    self_test()
    if args.self_test:
        print("Archive importer safety and preservation tests passed")
        return
    articles = import_archive(args.recovery_dir)
    archive_media(articles, download=args.download_media, check=args.check)
    rendered = json.dumps(articles, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != rendered:
            raise SystemExit("Archive output differs from recovered sources; rerun importer")
    else:
        OUTPUT.write_text(rendered)
    images = sum(block["type"] == "image" for item in articles for block in all_blocks(item["blocks"]))
    print(f"{'Verified' if args.check else 'Imported'} {len(articles)} articles, {images} original images, and {sum(len(item['blocks']) for item in articles)} top-level content blocks")


if __name__ == "__main__":
    main()
