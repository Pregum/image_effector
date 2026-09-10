#!/usr/bin/env node

// 時事クロスワードの心臓部（フィード解析 → 語の抽出 → 盤面）を、
// ネットワークにもD1にも触らずに検証する。

import assert from "node:assert/strict";
import { parseFeed, feedList, DEFAULT_FEEDS } from "../src/news.js";
import {
  buildGrid,
  buildPuzzle,
  buzzSeries,
  maskedClue,
  normalizeWord,
  pickEvidence,
  pickWords,
  rankCandidates,
  solutionString,
  wordsInTitle,
} from "../public/crossword-core.js";

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const hoursAgo = (h) => NOW - h * 3_600_000;

// ---------------------------------------------------------------- フィード解析
{
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item>
      <title>エヌビディア株が最高値を更新 - NHK</title>
      <link>https://example.test/a</link>
      <pubDate>Wed, 09 Sep 2026 12:00:00 GMT</pubDate>
      <source url="https://nhk.test">NHK</source>
    </item>
    <item>
      <title><![CDATA[ワールドカップ 日本代表が勝利 &amp; 決勝へ]]></title>
      <link>https://example.test/b</link>
      <pubDate>まったく日付ではない</pubDate>
    </item>
    <item><title>短い</title><link>https://example.test/c</link></item>
  </channel></rss>`;

  const items = parseFeed(rss, { now: NOW });
  assert.equal(items.length, 2, "見出しが短すぎるものは落とす");
  assert.equal(items[0].title, "エヌビディア株が最高値を更新", "媒体名は見出しから切り離す");
  assert.equal(items[0].source, "NHK");
  assert.equal(items[0].publishedAt, Date.parse("Wed, 09 Sep 2026 12:00:00 GMT"));
  assert.equal(items[1].title, "ワールドカップ 日本代表が勝利 & 決勝へ", "実体参照とCDATAを解く");
  assert.equal(items[1].publishedAt, NOW, "日付が読めないときは取得時刻にする");

  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <title>アニメ映画が興行収入トップに</title>
    <link href="https://example.test/d"/>
    <updated>2026-09-08T01:02:03Z</updated>
  </entry></feed>`;
  const [entry] = parseFeed(atom, { now: NOW });
  assert.equal(entry.link, "https://example.test/d", "Atomのlinkはhref属性から取る");
  assert.equal(entry.publishedAt, Date.parse("2026-09-08T01:02:03Z"));

  assert.deepEqual(feedList({}), DEFAULT_FEEDS);
  assert.deepEqual(
    feedList({ NEWS_FEEDS: "https://a.test/rss, javascript:alert(1) ,https://b.test/rss" }),
    ["https://a.test/rss", "https://b.test/rss"],
    "https以外のフィードは受け付けない"
  );
}

// ---------------------------------------------------------------- 語の抽出
{
  assert.equal(normalizeWord("シャンプー"), "シヤンプー", "小書き文字は1マス分の大きい字にする");
  const words = [...wordsInTitle("ニュース速報 スマートフォンのアプリが人気").keys()];
  assert.ok(words.includes("スマートフオン"), "カタカナ語を拾う");
  assert.ok(!words.includes("ニュース"), "見出しの飾り語は除く");
  assert.ok(!words.includes("アプリ"), "汎用語は除く");
}

// ---------------------------------------------------------------- 採点と選抜
{
  const articles = [
    { title: "エヌビディアが決算発表", source: "A社", publishedAt: hoursAgo(1), link: "https://a.test/1" },
    { title: "エヌビディア株が急伸", source: "B社", publishedAt: hoursAgo(3), link: "https://b.test/2" },
    { title: "エヌビディアとアマゾンが提携", source: "C社", publishedAt: hoursAgo(30), link: "https://c.test/3" },
    { title: "アマゾンが新サービス", source: "A社", publishedAt: hoursAgo(2), link: "https://a.test/4" },
  ];
  const ranked = rankCandidates(articles, { now: NOW, windowMs: 86_400_000 });
  const top = ranked[0];
  assert.equal(top.word, "エヌビデイア", "媒体が割れて回数も多い語が上に来る");
  assert.equal(top.count, 2, "期間の外にある記事は数えない");
  assert.equal(top.sources, 2);

  const chosen = pickWords(
    [
      { word: "ワールドカツプ", count: 5, sources: 3, score: 9 },
      { word: "ワールド", count: 5, sources: 3, score: 8 },
      { word: "エヌビデイア", count: 4, sources: 2, score: 7 },
    ],
    { limit: 5 }
  );
  assert.deepEqual(chosen.map((c) => c.word), ["ワールドカツプ", "エヌビデイア"], "包含関係の語は片方だけ");
}

// ---------------------------------------------------------------- 盤面
{
  const { placed } = buildGrid(["エヌビデイア", "アマゾン", "インフレ"]);
  assert.equal(placed.length, 3, "交差できる語はすべて置く");
  const cellOf = new Map();
  for (const e of placed) {
    for (let i = 0; i < e.word.length; i++) {
      const x = e.x + (e.dir === "h" ? i : 0);
      const y = e.y + (e.dir === "v" ? i : 0);
      const k = `${x},${y}`;
      const prev = cellOf.get(k);
      assert.ok(prev === undefined || prev === e.word[i], "交差マスの字が食い違わない");
      cellOf.set(k, e.word[i]);
    }
  }
  assert.ok(placed.slice(1).every((e) => e.dir !== placed[0].dir || e.y !== placed[0].y), "同じ行に並べ直さない");

  // 1文字も共有しない語は置けないので、静かに捨てる（例外にしない）
  const lonely = buildGrid(["アイウ", "エオカ"]);
  assert.equal(lonely.placed.length, 1);
}

// ---------------------------------------------------------------- 出題データ一式
{
  const titles = [
    ["エヌビディアが決算を発表", "A社"],
    ["エヌビディア株が最高値", "B社"],
    ["インフレ率が再び上昇", "C社"],
    ["インフレで家計が悲鳴", "A社"],
    ["ワールドカップ 開幕迫る", "B社"],
    ["ワールドカップの放送予定", "D社"],
    ["アマゾンが配送網を拡大", "C社"],
    ["アマゾンの新型端末", "B社"],
    ["リニア開業が遅れる見通し", "A社"],
    ["リニアの試験走行", "D社"],
  ];
  const articles = titles.map(([title, source], i) => ({
    title,
    source,
    link: `https://${source}.test/${i}`,
    publishedAt: hoursAgo(i + 1),
  }));

  const puzzle = buildPuzzle(articles, { range: "1d", now: NOW, seed: "test" });
  assert.ok(puzzle, "出題データが作れる");
  assert.ok(puzzle.entries.length >= 3, "3語以上は載る");
  assert.equal(puzzle.width * puzzle.height, puzzle.cells.length, "セルの数が盤の広さと合う");

  for (const e of puzzle.entries) {
    assert.ok(e.num > 0, "すべての語に番号が振られる");
    assert.ok(e.clue.length > 0, "ヒントが空でない");
    assert.ok(!e.clue.includes(e.surface), "ヒントに答えそのものを載せない");
    assert.ok(e.evidence.length >= 1 && e.evidence.length <= 3, "根拠は最大3本");
    for (const ev of e.evidence) assert.match(ev.link, /^https:\/\//);
    assert.equal(e.buzz.length, 24, "1日ぶんは1時間刻み");
    assert.equal(e.buzz.reduce((s, b) => s + b.n, 0), e.mentions, "話題量の合計が言及数と合う");
    // 盤の字と語が一致している
    for (let i = 0; i < e.word.length; i++) {
      const cell = puzzle.cells.find(
        (c) => c.x === e.x + (e.dir === "h" ? i : 0) && c.y === e.y + (e.dir === "v" ? i : 0)
      );
      assert.equal(cell.ch, e.word[i]);
    }
  }

  const blanks = puzzle.cells.filter((c) => c.ch && !c.given);
  assert.ok(puzzle.cells.some((c) => c.given), "最初から埋まっているマスがある");
  assert.ok(puzzle.rack.length >= blanks.length, "ラックには空きマスぶんの字が揃っている");
  const rack = [...puzzle.rack];
  for (const c of blanks) {
    const at = rack.indexOf(c.ch);
    assert.ok(at >= 0, `ラックに ${c.ch} がある`);
    rack.splice(at, 1);
  }
  assert.ok(rack.length >= 2, "おじゃまタイルが混ざっている");

  // 同じ種なら同じ盤（キャッシュしても再現する）
  const again = buildPuzzle(articles, { range: "1d", now: NOW, seed: "test" });
  assert.equal(solutionString(again), solutionString(puzzle));
  assert.deepEqual(again.rack, puzzle.rack);

  // 期間の外の記事しか無ければ出題しない
  const stale = articles.map((a) => ({ ...a, publishedAt: NOW - 40 * 86_400_000 }));
  assert.equal(buildPuzzle(stale, { range: "1d", now: NOW }), null);

  const weekly = buildPuzzle(articles, { range: "1w", now: NOW, seed: "test" });
  assert.equal(weekly.entries[0].buzz.length, 7, "1週間ぶんは1日刻み");
}

// ---------------------------------------------------------------- 根拠・ヒント
{
  const articles = [
    { title: "リニア開業が遅れる", source: "A社", link: "https://a.test/1", publishedAt: hoursAgo(1) },
    { title: "リニアの続報", source: "A社", link: "https://a.test/2", publishedAt: hoursAgo(2) },
    { title: "リニア試験走行を公開", source: "B社", link: "https://b.test/3", publishedAt: hoursAgo(5) },
    { title: "無関係な話題", source: "C社", link: "https://c.test/4", publishedAt: hoursAgo(1) },
  ];
  const ev = pickEvidence(articles, "リニア");
  assert.equal(ev.length, 3);
  assert.equal(ev[0].source, "A社");
  assert.equal(ev[1].source, "B社", "先に媒体を散らしてから同じ媒体の2本目を足す");

  const series = buzzSeries(articles, "リニア", { now: NOW, windowMs: 86_400_000, buckets: 24 });
  assert.equal(series.reduce((s, b) => s + b.n, 0), 3);
  assert.equal(series[23].n, 1, "1時間前の記事は最後のバケツに入る");
  assert.equal(series[22].n, 1, "2時間前の記事はその手前に入る");

  assert.equal(maskedClue(articles, "リニア", "リニア"), "〇〇〇の続報");
  assert.match(maskedClue([], "リニア", "リニア"), /3文字/);
}

console.log("NOIZ LAB news crossword tests passed");
