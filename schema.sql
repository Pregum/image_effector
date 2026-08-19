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
