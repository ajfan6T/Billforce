/** Core tables: settings, users, permissions, audit trail, numbering, financial years, backups. */
export const CORE_SCHEMA = /* sql */ `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Permissions granted to the manager and cashier roles (owner always has all).
CREATE TABLE role_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

-- Who did what and when. Written in the same transaction as the change itself.
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  summary TEXT NOT NULL,
  details TEXT
);
CREATE INDEX idx_activity_at ON activity_log (at);
CREATE INDEX idx_activity_entity ON activity_log (entity_type, entity_id);
CREATE INDEX idx_activity_user ON activity_log (user_id);

-- Full snapshots of documents after every change (create / edit / cancel), for the audit trail.
CREATE TABLE document_revisions (
  id INTEGER PRIMARY KEY,
  doc_type TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  reason TEXT,
  user_id INTEGER,
  username TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_revisions_doc ON document_revisions (doc_type, doc_id);

-- Document number series, reset every financial year.
CREATE TABLE sequences (
  key TEXT NOT NULL,
  fy_start TEXT NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, fy_start)
);

CREATE TABLE financial_years (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL UNIQUE,
  end_date TEXT NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  closed_by INTEGER,
  closing_entry_id INTEGER,
  notes TEXT
);

CREATE TABLE backup_history (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto', 'manual', 'safety')),
  path TEXT NOT NULL,
  size_bytes INTEGER,
  user_id INTEGER,
  note TEXT
);
`;
