-- Registered indexes: anything that wants to be told about MCP server changes.
CREATE TABLE indexes (
  id                   TEXT PRIMARY KEY,          -- "dns:<domain>:<key>" | "atproto:<did>:<rkey>"
  method               TEXT NOT NULL,             -- 'dns' | 'atproto'
  domain               TEXT NOT NULL,             -- the verified domain
  auth_key             TEXT,                      -- dns method only
  did                  TEXT,                      -- atproto method only
  rkey                 TEXT,                      -- atproto method only
  endpoint             TEXT NOT NULL,
  version              TEXT NOT NULL,             -- record/payload format version, e.g. '1'
  status               TEXT NOT NULL,             -- 'active' | 'suspended' | 'revoked'
  status_reason        TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  verified_at          INTEGER NOT NULL,
  last_attempt_at      INTEGER,
  last_success_at      INTEGER,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX indexes_status ON indexes (status);
CREATE INDEX indexes_did ON indexes (did);

-- Every MCP server URL we've ever been told about, with the latest state we observed.
-- Served at GET /servers as a history log (NOT a list of currently working servers).
CREATE TABLE servers (
  url               TEXT PRIMARY KEY,
  first_seen_at     INTEGER NOT NULL,
  status            TEXT NOT NULL,                -- 'pending' | 'ok' | 'auth_required' | 'unreachable'
  last_submitted_at INTEGER,
  last_probed_at    INTEGER,
  last_ok_at        INTEGER,
  last_error        TEXT,
  info_hash         TEXT,
  info              TEXT                          -- JSON: last successful probe result
);
CREATE INDEX servers_first_seen ON servers (first_seen_at);

-- Append-only event log; also served at /events for backfill.
CREATE TABLE events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  server_url  TEXT,
  payload     TEXT NOT NULL,                      -- JSON event (without seq)
  created_at  INTEGER NOT NULL
);
CREATE INDEX events_created ON events (created_at);
CREATE INDEX events_server ON events (server_url, seq);

-- atproto records we've seen, so deletes (which carry no record body) can be resolved.
CREATE TABLE atproto_records (
  did             TEXT NOT NULL,
  collection      TEXT NOT NULL,
  rkey            TEXT NOT NULL,
  cid             TEXT,
  value           TEXT,                           -- server URL or index endpoint
  domain_verified INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (did, collection, rkey)
);
