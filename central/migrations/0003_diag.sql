-- Operator diagnostics: gateway warnings, slow/failed gateway calls, live-view lifecycle. Kept 7 days.
CREATE TABLE diag_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  site_id TEXT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX diag_log_site ON diag_log(site_id, at);
