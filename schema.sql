CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  prompt TEXT,
  recipe TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'image/webp',
  thumb_type TEXT NOT NULL DEFAULT 'image/webp',
  parent_a TEXT,
  parent_b TEXT,
  caption TEXT,
  embedding TEXT,
  -- 共有期限(epoch ms)。0 = 非公開。期限内のみ誰でも閲覧可
  shared INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_works_created ON works (created_at DESC);

-- クラウド保存したプロジェクト。実体(Project JSON)はR2、ここは一覧用のメタだけ
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  cuts INTEGER NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects (updated_at DESC);

-- 時事クロスワードが使う見出しの控え。本文は持たず、見出し・媒体・掲載時刻だけ
CREATE TABLE IF NOT EXISTS news_articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles (published_at DESC);

-- 期間ごとに組んだ出題。id = "1d-<通し番号>" のように期間と時間帯で決まる
CREATE TABLE IF NOT EXISTS crossword_puzzles (
  id TEXT PRIMARY KEY,
  range_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  solution_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crossword_created ON crossword_puzzles (created_at DESC);

-- クリアタイム。出題ごとの速さを競うだけで、個人は追わない
CREATE TABLE IF NOT EXISTS crossword_scores (
  id TEXT PRIMARY KEY,
  puzzle_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_puzzle ON crossword_scores (puzzle_id, ms ASC);
