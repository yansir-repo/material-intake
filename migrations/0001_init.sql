-- 邀请：快照、门（key 的哈希）、状态。费用不在这里记：已花和已预留由 calls 求和（一个事实一处）。
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL,
  budget_nano INTEGER,                         -- NULL = 不设上限
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'revoked')),
  closed_at INTEGER,                           -- close / revoke 的时间；过期的邀请没有它，用 expires_at
  originals_purged_at INTEGER                  -- 原件按 retainDays 删掉的时间
);

-- 轮次：只追加。草稿轮 = submitted_at 为空的那一轮（每个邀请至多一个）。
CREATE TABLE rounds (
  invite_id TEXT NOT NULL REFERENCES invites(id),
  n INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  manifest TEXT,                               -- 提交时冻结的 manifest.json
  PRIMARY KEY (invite_id, n)
);

-- 对方交的文件（每个文件属于一轮）。处理到哪一步不存：由 products 推出来（shared/model.ts）。
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES invites(id),
  round INTEGER NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  facts TEXT NOT NULL DEFAULT '{}',
  assignment TEXT,                             -- JSON Assignment；NULL = 还没归类
  failure TEXT,                                -- JSON {op, reason}：对方能修的失败
  created_at INTEGER NOT NULL
);
CREATE INDEX files_round ON files(invite_id, round);
CREATE INDEX files_sha ON files(invite_id, sha256);

-- 产物：同一邀请内 (sha256, op, params) 唯一决定（docs/format.md §2.1）。图片在 R2（r2_prefix），文字在 text。
CREATE TABLE products (
  invite_id TEXT NOT NULL REFERENCES invites(id),
  sha256 TEXT NOT NULL,
  step_id TEXT NOT NULL,                       -- <op>.<规范参数哈希前 8 位>
  op TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done', 'skipped', 'partial')),
  reason TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  text TEXT,
  lost TEXT,
  model TEXT,
  reads TEXT,
  segments TEXT,
  r2_prefix TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (invite_id, sha256, step_id)
);

-- 对方对每一项的声明：「没有这项」和补充的话（原话）。
CREATE TABLE notes (
  invite_id TEXT NOT NULL REFERENCES invites(id),
  round INTEGER NOT NULL,
  item TEXT NOT NULL,
  none INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (invite_id, round, item)
);

-- 模型调用的流水，也是费用的唯一账本：reserved 计估价，settled 计实际，released 不计。
-- 预留是一条带条件的 INSERT（worker/ledger.ts）：已花 + 已预留 + 这次 ≤ 上限 才插得进去，原子的。
CREATE TABLE calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_id TEXT NOT NULL REFERENCES invites(id),
  round INTEGER NOT NULL,
  use TEXT NOT NULL CHECK (use IN ('sort', 'describe', 'transcribe')),
  model TEXT NOT NULL,
  est_nano INTEGER NOT NULL,
  used_nano INTEGER,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'refused')),
  at INTEGER NOT NULL
);
CREATE INDEX calls_invite ON calls(invite_id, status);
