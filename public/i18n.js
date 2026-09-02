// 軽量な多言語対応。
// 日本語の文字列そのものをキーにすることで、既存コードへの後付けを容易にしている。
// 未翻訳の文字列は日本語のまま表示される（壊れない）。

const EN = {
  // --- ヘッダ・共通 ---
  "画像エフェクト実験室": "Image Effect Studio",
  "NOIZ LAB — 画像エフェクト実験室": "NOIZ LAB — Image Effect Studio",
  "◧ サンプル": "◧ Samples",
  "サンプル画像を切り替える": "Cycle through sample images",
  "画像を開く": "Open image",
  "◇ おまかせ": "◇ Surprise me",
  "ランダムに効果をかける": "Apply random effects",
  "ギャラリー": "Gallery",
  "ギャラリーへ保存": "Save to gallery",
  "PNG保存": "Save PNG",
  "閉じる": "Close",
  "クリア": "Clear",
  "サイズ": "Size",
  "強さ": "Amount",

  // --- ステージ ---
  "編集": "Edit",
  "▶ 動画プレビュー": "▶ Video preview",
  "画像をドラッグ＆ドロップ / 貼り付け（⌘V）でも読み込めます": "Drag & drop or paste (⌘V) an image",
  "アニメーション": "Animate",
  "書き出し:": "Export:",
  "元": "Orig",
  "現在のエフェクト設定をURLで共有": "Share the current effect settings as a URL",
  "🔗 レシピURL": "🔗 Recipe URL",
  "𝕏 シェア": "𝕏 Share",
  "Xでシェア": "Share on X",
  "Xでシェア（ギャラリーがある構成では、加工後の画像がカードに出る共有リンクで投稿します）":
    "Share on X (with a gallery backend, posts a share link whose card shows the edited image)",
  "共有リンク作成中…": "Creating share link…",
  "キー設定で画像付き": "Set a key for image cards",
  "アクセスキーを設定すると、次からは加工後の画像がカードに出る共有リンクで投稿できます。":
    "Set an access key and the next share will post a link whose card shows the edited image.",
  "共有リンク失敗": "Share link failed",
  "NOIZ LAB で画像にエフェクトをかけた🎛️": "Made this with NOIZ LAB 🎛️",
  "コピーしました ✓": "Copied ✓",
  "コピー失敗": "Copy failed",

  // --- AI ---
  "／ AIで元画像を生成": "／ Generate a source image with AI",
  "例: 夕暮れの高速道路を走る古い車": "e.g. an old car on a highway at dusk",
  "写真": "Photo",
  "シーン": "Scene",
  "「写真」はFLUX.1で画像生成、「シーン」はベクター風イラストを描画。日本語OK。":
    "“Photo” generates an image with a diffusion model; “Scene” draws a flat vector illustration. Any language works.",
  "生成中…": "Generating…",
  "描画中…": "Drawing…",
  "リクエストが多すぎます。1分ほど待ってから再試行してください。":
    "Too many requests. Please wait about a minute and try again.",
  "本日のAI生成の無料枠を使い切りました。日本時間 朝9時にリセットされます。":
    "Today's free AI quota is used up. It resets at 00:00 UTC.",
  "生成完了。エフェクトをかけてみてください。": "Done. Try adding some effects.",
  "生成に失敗しました。少し待って再試行してください。": "Generation failed. Please try again shortly.",
  "シーンを描画しました。エフェクトをかけてみてください。": "Scene drawn. Try adding some effects.",
  "シーン生成に失敗しました。再試行してください。": "Scene generation failed. Please try again.",
  "画像を読み込めませんでした": "Could not load that image",

  // --- プリセット ---
  "／ プリセット": "／ Presets",

  // --- 文字入れ ---
  "／ サムネ文字入れ": "／ Thumbnail text",
  "タイトル文字（| で改行、空で非表示）": "Title text (| for a new line, empty to hide)",
  "ドット": "Dot",
  "ゴシック": "Sans",
  "等幅": "Mono",
  "極太": "Heavy",
  "明朝": "Mincho",
  "丸ゴ": "Round",
  "ポップ": "Pop",
  "レゲエ": "Reggae",
  "白": "White",
  "黒": "Black",
  "蛍光": "Neon",
  "ピンク": "Pink",
  "横位置": "Horizontal",
  "縦位置": "Vertical",
  "プレビュー上をドラッグしても文字を動かせます": "You can also drag the text on the preview",

  // --- 重ね画像 ---
  "／ 重ね画像": "／ Overlay image",
  "画像を選ぶ": "Choose image",
  "不透明度": "Opacity",
  "通常": "Normal",
  "スクリーン": "Screen",
  "乗算": "Multiply",
  "加算": "Add",
  "ドラッグで移動。合成した上からエフェクトが全体にかかります。":
    "Drag to move. Effects are applied on top of the composited result.",

  // --- 動画 ---
  "／ ショート動画": "／ Short video",
  "＋ 今の画像": "＋ Current",
  "＋ 画像・動画": "＋ Images / videos",
  "▣ プロジェクト保存": "▣ Save project",
  "↻ 前回の続き": "↻ Continue latest",
  "↓ JSON書き出し": "↓ Export JSON",
  "↑ JSONを開く": "↑ Open JSON",
  "このブラウザに素材と編集内容を保存できます。": "Save media and edits in this browser.",
  "＋ ファイル": "＋ File",
  "1拍": "1 beat",
  "2拍": "2 beats",
  "4拍": "4 beats",
  "♪ 同期": "♪ Sync",
  "♫ BGMを選ぶ": "♫ Choose music",
  "フェード": "Fade",
  "ワイプ": "Wipe",
  "ディゾルブ": "Dissolve",
  "グリッチ": "Glitch",
  "各カットの表示": "Hold per cut",
  "切替の長さ": "Transition",
  "ズーム演出 (Ken Burns)": "Zoom (Ken Burns)",
  "カットごとのエフェクト（追加時の設定を記憶）": "Per-cut effects (remembers settings when added)",
  "▶ 動画書き出し (MP4)": "▶ Export video (MP4)",
  "◉ GIF書き出し": "◉ Export GIF",
  "「＋ 今の画像」でカットを並べ、下の書き出し比率（9:16など）を選んで書き出し。エフェクトと文字は動画全体にかかります。":
    "Add cuts with “＋ Current”, pick an export ratio (e.g. 9:16) below, then export. Effects and text apply to the whole video.",
  "録画中…": "Recording…",
  "エンコード中…": "Encoding…",
  "「＋ 今の画像」でカットを並べてください。": "Add cuts with “＋ Current”.",
  "プレビューにはカットを1枚以上追加してください。": "Add at least one cut to preview.",
  "動画の書き出しに失敗しました（Safariでは非対応の場合があります）。":
    "Video export failed (may be unsupported in Safari).",
  "GIFの書き出しに失敗しました。": "GIF export failed.",
  "書き出しがタイムアウトしました。録画中はこのウィンドウを前面に表示したままにしてください。":
    "Export timed out. Keep this window in the foreground while recording.",
  "BGMを読み込めませんでした（mp3/wav/m4a等）。": "Could not load that audio file (mp3/wav/m4a).",
  "画像を読み込めませんでした。": "Could not load that image.",
  "カットは最大8枚までです。": "Up to 8 cuts.",

  // --- 動画（クリップ・トランジション・導線） ---
  "かんたん動画の作り方": "How to make a video",
  "素材": "Media",
  "雰囲気": "Mood",
  "保存": "Save",
  "動画クリップ": "Video clip",
  "開始": "Start",
  "終了": "End",
  "サムネイルを選ぶとトリムできます。動画音声は現在BGMへ置き換えて書き出します。":
    "Select a thumbnail to trim it. For now, a clip's own audio is replaced by the background music on export.",
  "パンチズーム": "Punch zoom",
  "フラッシュ": "Flash",
  "プッシュ": "Push",
  "フィルムバーン": "Film burn",
  "すべてNOIZ LAB独自実装。プレビューとMP4/GIF書き出しに反映されます。":
    "All implemented in NOIZ LAB itself. They apply to the preview and to MP4/GIF export.",

  // --- file:// で開いたときの警告 ---
  "ローカルサーバー経由で開いてください": "Please open this through a local server",
  "見た目は表示できますが、WebGL編集・動画書き出し・AI生成は":
    "The page renders, but WebGL editing, video export and AI generation need a server rather than",
  "直開きでは動作しません。": "opened directly.",

  "トランジション": "Transition",
  "Project JSONが大きすぎます（上限210MB）。": "That Project JSON is too large (210MB limit).",
  "Project JSONを書き出せませんでした。": "Could not export the Project JSON.",
  "Project JSONを読み込み中…": "Loading Project JSON…",
  "Workers AI で生成しています（10秒前後）…": "Generating with Workers AI (about 10 seconds)…",
  "プロジェクトを開けませんでした。": "Could not open that project.",
  "保存されたプロジェクトはありません。": "No saved project yet.",
  "保存できませんでした。ブラウザの保存領域を確認してください。":
    "Could not save. Check your browser's storage.",
  "先に画像か動画を追加してください。": "Add an image or video first.",
  "動画クリップを含む場合はMP4で書き出してください。GIFは画像カットのみ対応しています。":
    "Export as MP4 when the timeline contains video clips. GIF supports image cuts only.",
  "素材が150MBを超えるためJSONへ埋め込めません。クラウド参照形式の実装後に対応します。":
    "The media exceeds 150MB, so it cannot be embedded in JSON. This will be supported once cloud references land.",
  "素材を含むProject JSONを作成中…": "Building a Project JSON with the media embedded…",

  "／ 適用順": "／ Order",
  "色処理の適用順": "Color stage order",
  "ドラッグで色処理の順番を入れ替えられます。上から順に適用されます。":
    "Drag to reorder the color stages. They are applied from top to bottom.",
  "既定に戻す": "Reset to default",
  "トラッキングノイズ": "Tracking noise",
  "文字入れ": "Text",
  "◎ 動画をレビュー": "◎ Review video",
  "スコア": "Score",
  "カット": " cuts",
  "秒": "s",
  "指摘はありません。": "No issues found.",
  "レビューを実行できませんでした。": "Could not run the review.",
  "要修正": "Fix",
  "注意": "Warn",
  "提案": "Tip",
  "このカットの字幕（無音でも伝わる一言）": "Caption for this cut (readable with sound off)",
  "動画のテーマ（例: 夏の終わりのドライブ）": "Theme of the video (e.g. a drive at the end of summer)",
  "✎ AIで字幕を作る": "✎ Write captions with AI",
  "✂ 半分で分割": "✂ Split in half",
  "生成中…": "Generating…",
  "字幕を生成しました。カットを選んで手直しできます。": "Captions generated. Select a cut to edit one.",
  "字幕の生成に失敗しました。再試行してください。": "Caption generation failed. Please try again.",
  "この構成ではAI機能を使えません。": "AI features are not available in this deployment.",
  "クリップを2カットに分割しました。": "Split the clip into two cuts.",
  "分割するには0.4秒以上の長さが必要です。": "The clip needs to be at least 0.4s to split.",
  "STYLE BIBLE": "STYLE BIBLE",
  "／ カット間の一貫性": "/ consistency across cuts",
  "参照画像から色を拾う": "Pick colors from a reference",
  "クリア": "Clear",
  "参照画像": "Reference",
  "参照画像の色を6色に丸めて、全カットの色をそこへ寄せます。": "The reference is reduced to six colors, and every cut is pulled toward them.",
  "参照画像を読み込めませんでした。": "Could not read the reference image.",
  "禁止表現": "Avoid",
  "例: 文字、透かし、崩れた手": "e.g. text, watermark, distorted hands",
  "全カットに統一": "Apply to every cut",
  "「全カットに統一」で、いまのラック設定・seed・パレットを全カットのレシピへ焼き付けます。AI画像生成にも同じパレットと禁止表現を渡します。": "\u201cApply to every cut\u201d bakes the current rack settings, seed and palette into every cut. AI image generation gets the same palette and avoid-list.",
  "に同じ設定を適用しました。": " now share the same settings.",
  "先に画像か動画を追加してください。": "Add an image or a video first.",
  "PALETTE LOCK": "PALETTE LOCK",
  "パレット寄せ": "Palette lock",
  "寄せる強さ": "Strength",
  "ドラッグで色処理の順番を入れ替えられます。上から順に適用されます。": "Drag to reorder the color stages. They are applied top to bottom.",
  "☁ クラウドへ保存": "☁ Save to cloud",
  "☁ クラウドの一覧": "☁ Cloud projects",
  "クラウドへ保存中…": "Saving to the cloud…",
  "クラウドへ保存しました": "Saved to the cloud",
  "クラウドへ保存できませんでした。": "Could not save to the cloud.",
  "素材が大きすぎてクラウドに保存できません（上限40MB）。": "The assets are too large to save to the cloud (40MB limit).",
  "ギャラリーのアクセスキーを設定してください。": "Set the gallery access key first.",
  "アクセスキーが違います。": "That access key is not right.",
  "この構成ではクラウド保存を使えません。": "Cloud saving is not available in this deployment.",
  "クラウドに保存したプロジェクトはまだありません。": "No projects saved to the cloud yet.",
  "クラウドの一覧を取得できませんでした。": "Could not list the cloud projects.",
  "クラウドから読み込み中…": "Loading from the cloud…",
  "クラウドから開きました": "Opened from the cloud",
  "クラウドから開けませんでした。": "Could not open it from the cloud.",
  "読み込み中…": "Loading…",
  "開く": "Open",
  "削除": "Delete",
  "本当に？": "Sure?",
  "削除できませんでした。": "Could not delete it.",
  // --- エフェクトラック ---
  "／ エフェクトラック": "／ Effect rack",
  "ぼかし": "Blur",
  "ピクセルソート": "Pixel sort",
  "色収差": "Chromatic aberration",
  "ハレーション": "Halation",
  "色調エモ化": "Color grade",
  "光漏れ": "Light leak",
  "モザイク": "Pixelate",
  "ディザ / 網点": "Dither / halftone",
  "ブラウン管": "CRT",
  "粒子・減光": "Grain & vignette",
  "よこ": "Horiz",
  "たて": "Vert",
  "しきい値・下": "Threshold low",
  "しきい値・上": "Threshold high",
  "しきい値": "Threshold",
  "ずれ幅": "Offset",
  "◇ パターンを振り直す": "◇ Reroll pattern",
  "ベイヤー": "Bayer",
  "ハーフトーン": "Halftone",
  "アスキー": "ASCII",
  "スケール": "Scale",
  "階調": "Levels",
  "湾曲": "Curvature",
  "走査線": "Scanlines",
  "トラッキング": "Tracking",
  "ゆらぎ": "Wobble",
  "グレイン": "Grain",
  "ビネット": "Vignette",
  "色温度": "Temperature",
  "フェード": "Fade",
  "ティール&オレンジ": "Teal & orange",
  "彩度": "Saturation",
  "コントラスト": "Contrast",
  "ディザ後": "After dither",
  "ディザ前": "Before dither",

  // --- ギャラリー ---
  "／ 作品ギャラリー": "／ Gallery",
  "◈ グラフ": "◈ Graph",
  "▤ 一覧": "▤ List",
  "アクセスキー": "Access key",
  "保存した作品（元画像+レシピ）を読み込んで再編集できます。":
    "Load a saved work (source image + recipe) to keep editing it.",
  "アクセスキーを入力すると一覧が表示されます。": "Enter your access key to see saved works.",
  "アクセスキーが違います。": "That access key is not correct.",
  "読み込み中…": "Loading…",
  "まだ作品がありません。「ギャラリーへ保存」で追加できます。":
    "No works yet. Use “Save to gallery” to add one.",
  "一覧の取得に失敗しました。": "Could not load the gallery.",
  "読み込みに失敗しました。": "Could not load that work.",
  "先にアクセスキーを入力してください。": "Please enter your access key first.",
  "保存中…": "Saving…",
  "保存しました ✓": "Saved ✓",
  "保存・系譜記録 ✓": "Saved with lineage ✓",
  "保存失敗": "Save failed",
  "保存が多すぎます": "Too many saves",
  "削除": "Delete",
  "共有リンクを作る（約1日で失効）": "Create a share link (expires in about a day)",
  "共有リンクの作成に失敗しました。": "Could not create the share link.",
  "この共有リンクは期限切れです（共有は約1日で失効します）。":
    "This share link has expired (share links last about a day).",
  "共有された作品を読み込みました。自由に加工できます。": "Loaded the shared work. Edit away.",
  "共有作品の読み込みに失敗しました。": "Could not load the shared work.",
  "子作品の生成に失敗しました。": "Could not create the child work.",

  // --- グラフ・提案 ---
  "クリックで選択（2つで掛け合わせ）／ ドラッグで回転・移動":
    "Click to select (two to crossbreed) ／ drag to rotate or pan",
  "◇ 次の一手": "◇ What's next",
  "開く": "Open",
  "⚡ 突然変異": "⚡ Mutate",
  "◇ 掛け合わせる": "◇ Crossbreed",
  "このレシピで作る": "Use this recipe",
  "シーンを作る": "Generate scene",
  "掛け合わせ: A(先に選択)の元画像に、AとBを混ぜたレシピを適用します。":
    "Crossbreed: applies a blend of A and B's recipes to A's source image.",
  "分析中…": "Analyzing…",
  "提案にはカットではなく保存作品が必要です。": "Suggestions need saved works, not video cuts.",
  "目立った穴は見つかりませんでした。作品を増やすと精度が上がります。":
    "No notable gaps found. Save more works to improve the suggestions.",
  "AIの提案が届くと、タイトルと「シーンを作る」ボタンが追加されます。":
    "When the AI responds, titles and “Generate scene” buttons will appear.",
  "離れたまとまり": "Distant clusters",
  "未使用の組み合わせ": "Unused combination",
  "未使用のエフェクト": "Unused effect",
  "未交配": "No offspring",
  "2つの系統をつなぐ作品": "A work bridging two lineages",
  "まだ枝分かれしていない作品": "A work with no branches yet",
  "AI無料枠を使い切ったため、今回はレシピ類似のみで表示します。":
    "AI quota is used up, so the graph uses recipe similarity only.",

  // --- フッタ ---
  "加工はすべてブラウザ内 (WebGL2) で完結し、画像は「ギャラリーへ保存」した時以外サーバーに送信されません。":
    "All editing happens in your browser (WebGL2). Images are never sent to a server unless you press “Save to gallery”.",
  "このサイトについて →": "About this site →",
  "この構成ではAI生成とギャラリーは無効です。エフェクト・動画・GIFはそのまま使えます。":
    "AI generation and the gallery are disabled in this deployment. Effects, video and GIF still work.",
};

// 優先順: URLハッシュ(#lang=en) > 保存済みの選択 > ブラウザの言語
const fromHash = (location.hash.match(/lang=(ja|en)/) || [])[1];
const stored = (() => {
  try { return localStorage.getItem("nl_lang"); } catch { return null; }
})();
export const LANG =
  fromHash || stored || ((navigator.language || "en").toLowerCase().startsWith("ja") ? "ja" : "en");

export function t(ja) {
  if (LANG === "ja") return ja;
  return EN[ja] ?? ja;
}

export function setLang(lang) {
  try { localStorage.setItem("nl_lang", lang); } catch {}
  location.reload();
}

// DOM内の日本語テキスト・placeholder・titleをまとめて置き換える。
// ラック等を組み立てた後に呼ぶことで、動的に作った要素も対象になる。
export function localizeDom(root = document.body) {
  if (LANG === "ja") return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n);
  for (const node of targets) {
    const raw = node.nodeValue;
    const key = raw.trim();
    if (!key || !EN[key]) continue;
    node.nodeValue = raw.replace(key, EN[key]);
  }
  for (const el of root.querySelectorAll("[placeholder]")) {
    const v = EN[el.getAttribute("placeholder")];
    if (v) el.setAttribute("placeholder", v);
  }
  for (const el of root.querySelectorAll("[title]")) {
    const v = EN[el.getAttribute("title")];
    if (v) el.setAttribute("title", v);
  }
  for (const el of root.querySelectorAll("[aria-label]")) {
    const v = EN[el.getAttribute("aria-label")];
    if (v) el.setAttribute("aria-label", v);
  }
}
