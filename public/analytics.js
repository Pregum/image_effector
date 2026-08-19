/* NOIZ LAB — 利用イベントの送信
 *
 * 目的は「どの機能がどれだけ使われているか」を知ることだけ。
 *  - Cookie も localStorage も使わない。訪問者を識別するIDは一切持たない
 *  - 画像・プロンプト・レシピの中身は送らない（機能名とラベルのみ）
 *  - 送信先(/api/event)が無い構成では何も送らず、キューも捨てる
 * 送信はまとめて sendBeacon で行うので、操作の邪魔にならない。
 */

const ENDPOINT = "/api/event";
const MAX_QUEUE = 20;   // サーバが1リクエストで受け取る上限に合わせる
const FLUSH_AT = 10;    // これだけ溜まったら送る
const FLUSH_MS = 5000;  // 溜まりきらなくてもこの間隔で送る

// pending: 構成の取得待ち（イベントは溜めておく） / on: 送る / off: 何もしない
let mode = "pending";
let queue = [];
let timer = null;

export function setAnalyticsEnabled(on) {
  mode = on ? "on" : "off";
  if (mode === "off") {
    queue = [];
    return;
  }
  flush();
}

export function track(e, l = "", v = 1) {
  if (mode === "off") return;
  if (queue.length >= MAX_QUEUE) return; // 溢れたぶんは捨てる（送信は最善努力）
  queue.push({ e, l: String(l).slice(0, 64), v });
  if (mode !== "on") return;
  if (queue.length >= FLUSH_AT) flush();
  else if (timer === null) timer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (mode !== "on" || queue.length === 0) return;
  const body = JSON.stringify({ events: queue });
  queue = [];
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
    } else {
      fetch(ENDPOINT, {
        method: "POST",
        body,
        keepalive: true,
        headers: { "content-type": "application/json" },
      }).catch(() => { /* 計測の失敗は無視する */ });
    }
  } catch { /* 同上 */ }
}

// タブを閉じる・隠れる直前に取りこぼしを送る（unloadより確実に発火する）
addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});
