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
