// ローマ字をカタカナに変える、1文字ずつ食わせる小さな変換器。
//
// タイムを competing するゲームなので、PCでは打鍵で入れられないと話にならない。
// ただしIMEの変換窓を経由すると確定までのラグがそのままタイムになるため、
// IMEに頼らず「打った英字をその場でカタカナにする」方式にした。
//
// 使い方: 押されたキーごとに feed(pending, key) を呼び、返ってきた kana を盤へ置く。
// pending は「まだ確定していない打ちかけの綴り」で、そのまま次の呼び出しへ渡す。

const TABLE = {
  a: "ア", i: "イ", u: "ウ", e: "エ", o: "オ",
  ka: "カ", ki: "キ", ku: "ク", ke: "ケ", ko: "コ",
  sa: "サ", si: "シ", shi: "シ", su: "ス", se: "セ", so: "ソ",
  ta: "タ", ti: "チ", chi: "チ", tu: "ツ", tsu: "ツ", te: "テ", to: "ト",
  na: "ナ", ni: "ニ", nu: "ヌ", ne: "ネ", no: "ノ",
  ha: "ハ", hi: "ヒ", hu: "フ", fu: "フ", he: "ヘ", ho: "ホ",
  ma: "マ", mi: "ミ", mu: "ム", me: "メ", mo: "モ",
  ya: "ヤ", yu: "ユ", yo: "ヨ",
  ra: "ラ", ri: "リ", ru: "ル", re: "レ", ro: "ロ",
  wa: "ワ", wo: "ヲ", nn: "ン", "n'": "ン",
  ga: "ガ", gi: "ギ", gu: "グ", ge: "ゲ", go: "ゴ",
  za: "ザ", zi: "ジ", ji: "ジ", zu: "ズ", ze: "ゼ", zo: "ゾ",
  da: "ダ", di: "ヂ", du: "ヅ", de: "デ", do: "ド",
  ba: "バ", bi: "ビ", bu: "ブ", be: "ベ", bo: "ボ",
  pa: "パ", pi: "ピ", pu: "プ", pe: "ペ", po: "ポ",
  va: "ヴァ", vi: "ヴィ", vu: "ヴ", ve: "ヴェ", vo: "ヴォ",

  kya: "キャ", kyu: "キュ", kyo: "キョ",
  sha: "シャ", shu: "シュ", sho: "ショ",
  sya: "シャ", syu: "シュ", syo: "ショ",
  cha: "チャ", chu: "チュ", cho: "チョ",
  tya: "チャ", tyu: "チュ", tyo: "チョ",
  nya: "ニャ", nyu: "ニュ", nyo: "ニョ",
  hya: "ヒャ", hyu: "ヒュ", hyo: "ヒョ",
  mya: "ミャ", myu: "ミュ", myo: "ミョ",
  rya: "リャ", ryu: "リュ", ryo: "リョ",
  gya: "ギャ", gyu: "ギュ", gyo: "ギョ",
  ja: "ジャ", ju: "ジュ", jo: "ジョ",
  jya: "ジャ", jyu: "ジュ", jyo: "ジョ",
  zya: "ジャ", zyu: "ジュ", zyo: "ジョ",
  bya: "ビャ", byu: "ビュ", byo: "ビョ",
  pya: "ピャ", pyu: "ピュ", pyo: "ピョ",
  fa: "ファ", fi: "フィ", fe: "フェ", fo: "フォ",
  she: "シェ", che: "チェ", je: "ジェ",
  la: "ア", li: "イ", lu: "ウ", le: "エ", lo: "オ",
  xa: "ア", xi: "イ", xu: "ウ", xe: "エ", xo: "オ",
  xya: "ヤ", xyu: "ユ", xyo: "ヨ", xtu: "ッ", ltu: "ッ",

  "-": "ー", ".": "ー",
};

const PREFIXES = new Set();
for (const romaji of Object.keys(TABLE)) {
  for (let i = 1; i < romaji.length; i++) PREFIXES.add(romaji.slice(0, i));
}

const isConsonant = (c) => /^[a-z]$/.test(c) && !"aiueon".includes(c);

/**
 * キーを1つ食べて、確定したカタカナと打ちかけの綴りを返す。
 * 返り値の kana は0文字以上（「kya」のように2文字まとめて確定することがある）。
 */
export function feedRomaji(pending, key) {
  const ch = String(key).toLowerCase();
  if (!/^[a-z'\-.]$/.test(ch)) return { kana: "", pending };

  let buf = `${pending}${ch}`;
  let kana = "";

  // 綴りが確定するまで、先頭から食べられるだけ食べる
  for (let guard = 0; guard < 8; guard++) {
    if (TABLE[buf]) {
      // より長い綴りに伸びる可能性があるものは、まだ確定させない（ki → kya）
      if (PREFIXES.has(buf)) return { kana, pending: buf };
      return { kana: kana + TABLE[buf], pending: "" };
    }
    if (PREFIXES.has(buf)) return { kana, pending: buf };

    // 「ん」: n の後ろに母音以外が来たら、そこで ン が確定する
    if (buf[0] === "n" && buf.length >= 2 && buf[1] !== "y") {
      kana += "ン";
      buf = buf.slice(1);
      continue;
    }
    // 促音: 同じ子音が2つ続いたら ッ
    if (buf.length >= 2 && buf[0] === buf[1] && isConsonant(buf[0])) {
      kana += "ッ";
      buf = buf.slice(1);
      continue;
    }
    // どうにもならない綴りは先頭を捨てて、打ち直しを待つ
    buf = buf.slice(1);
    if (!buf) return { kana, pending: "" };
  }
  return { kana, pending: "" };
}

// ひらがなで入る環境（かな入力・IMEの直接入力）も同じマスに置けるようにする
export const kanaToKatakana = (s) =>
  String(s).replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
