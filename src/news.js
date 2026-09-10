// 時事ネタの収集。
//
// RSS/Atomを取ってきて「見出し・媒体・掲載時刻」だけを持つ配列に均す。
// 本文は取らない（引用の範囲を見出しに限り、保存量も抑えるため）。
// パーサはXMLライブラリを使わず、必要な要素だけを正規表現で拾う。
// フィードの形は各社まちまちなので、RSS 2.0 と Atom の両方を受ける。

// 既定のフィード。環境変数 NEWS_FEEDS（カンマ区切り）で丸ごと差し替えられる。
// Googleニュースは「トップ + 主要トピック」を取ると、1日あたり数百件の見出しが集まる。
const GOOGLE = (path) => `https://news.google.com/rss${path}hl=ja&gl=JP&ceid=JP:ja`;
const TOPIC = (name) => GOOGLE(`/headlines/section/topic/${name}?`);

export const DEFAULT_FEEDS = [
  GOOGLE("?"),
  TOPIC("WORLD"),
  TOPIC("NATION"),
  TOPIC("BUSINESS"),
  TOPIC("TECHNOLOGY"),
  TOPIC("ENTERTAINMENT"),
  TOPIC("SPORTS"),
  TOPIC("SCIENCE"),
  TOPIC("HEALTH"),
];

export function feedList(env) {
  const raw = String(env?.NEWS_FEEDS || "").trim();
  if (!raw) return DEFAULT_FEEDS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https:\/\/\S+$/.test(s))
    .slice(0, 20);
}

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

// CDATA・実体参照・タグ混じりのどれで来ても、素のテキストに均す
function textOf(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  return decodeEntities(v.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attrOf(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

// Googleニュースの見出しは「本文の見出し - 媒体名」で来る。媒体名は別に持つので落とす
function splitTitle(title, source) {
  const m = title.match(/^(.*\S)\s[-–—]\s([^-–—]{2,40})$/);
  if (!m) return { title, source };
  return { title: m[1].trim(), source: source || m[2].trim() };
}

const parseDate = (s) => {
  const t = Date.parse(s || "");
  return Number.isFinite(t) ? t : 0;
};

// 見出しから記事を一意に決めるID。同じ話題が複数フィードに出ても1件に畳む
export async function articleId(title, source) {
  const buf = new TextEncoder().encode(`${title}|${source}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// RSS 2.0 / Atom のどちらでも {title, link, source, publishedAt} の配列を返す
export function parseFeed(xml, { now = Date.now() } = {}) {
  const text = String(xml || "");
  const blocks = text.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const out = [];
  for (const block of blocks) {
    const rawTitle = textOf(block, "title");
    if (!rawTitle) continue;
    const link = textOf(block, "link") || attrOf(block, "link", "href");
    const published =
      parseDate(textOf(block, "pubDate")) ||
      parseDate(textOf(block, "published")) ||
      parseDate(textOf(block, "updated")) ||
      parseDate(textOf(block, "dc:date"));
    const { title, source } = splitTitle(rawTitle, textOf(block, "source"));
    if (title.length < 6) continue;
    out.push({
      title: title.slice(0, 300),
      link: /^https?:\/\//.test(link) ? link.slice(0, 500) : "",
      source: (source || "").slice(0, 60),
      // 掲載時刻が無い/未来日のフィードがあるので、取得時刻で頭打ちにする
      publishedAt: published > 0 && published < now + 3_600_000 ? published : now,
    });
  }
  return out;
}

// 1フィード分を取ってくる。落ちているフィードで収集全体を止めない
export async function fetchFeed(url, { timeoutMs = 8000, now = Date.now() } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "user-agent":
          "NOIZ-LAB-news-crossword/1.0 (+https://github.com/Pregum/image_effector)",
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return [];
    return parseFeed(await res.text(), { now });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
