// LLMの返事からJSONだけを取り出す。
// 前後に説明文が付く・コードフェンスで囲まれる・閉じ括弧が余る、のいずれでも拾えるように、
// 最初の開き括弧から始めて、閉じ括弧を後ろから順に試す。
export function extractJson(text) {
  const tryFrom = (open, close) => {
    const start = text.indexOf(open);
    if (start < 0) return null;
    let end = text.lastIndexOf(close);
    while (end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch { /* ひとつ前の閉じ括弧で再試行 */ }
      end = text.lastIndexOf(close, end - 1);
    }
    return null;
  };
  const objAt = text.indexOf("{");
  const arrAt = text.indexOf("[");
  // 先に現れた方を優先して試す
  if (arrAt >= 0 && (objAt < 0 || arrAt < objAt)) {
    return tryFrom("[", "]") ?? tryFrom("{", "}");
  }
  return tryFrom("{", "}") ?? tryFrom("[", "]");
}
