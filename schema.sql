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
  caption TEXT
);
CREATE INDEX IF NOT EXISTS idx_works_created ON works (created_at DESC);
