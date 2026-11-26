-- Screens central schema v1

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'residential',
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
  address TEXT,
  notes TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  mdns TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX sites_client ON sites(client_id);

CREATE TABLE gateways (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  public_key TEXT NOT NULL,
  hostname TEXT,
  version TEXT,
  os TEXT,
  arch TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen INTEGER,
  connected_at INTEGER,
  info TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX gateways_site ON gateways(site_id);

CREATE TABLE enrollment_tokens (
  token_hash TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  gateway_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  room TEXT,
  ip TEXT,
  mac TEXT,
  port INTEGER,
  manufacturer TEXT,
  model TEXT,
  os_version TEXT,
  serial TEXT,
  firmware TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  power TEXT,
  current_app TEXT,
  last_seen INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  dns_mode TEXT NOT NULL DEFAULT 'monitor',
  dns_policy TEXT NOT NULL DEFAULT 'balanced',
  monitor_until INTEGER,
  dns_allow TEXT NOT NULL DEFAULT '[]',
  dns_block TEXT NOT NULL DEFAULT '[]',
  private_dns TEXT,
  secrets TEXT,
  facts TEXT NOT NULL DEFAULT '{}',
  privacy TEXT NOT NULL DEFAULT '{}',
  privacy_score INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX devices_site ON devices(site_id);
CREATE INDEX devices_mac ON devices(mac);

CREATE TABLE discovered (
  site_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  mac TEXT,
  kind_guess TEXT,
  name TEXT,
  model TEXT,
  manufacturer TEXT,
  hints TEXT NOT NULL DEFAULT '{}',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  ignored INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, ip)
);

CREATE TABLE device_apps (
  device_id TEXT NOT NULL,
  package TEXT NOT NULL,
  label TEXT,
  version_name TEXT,
  version_code INTEGER,
  system INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  permissions TEXT NOT NULL DEFAULT '[]',
  icon TEXT,
  app_id TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (device_id, package)
);

CREATE TABLE app_catalog (
  package TEXT PRIMARY KEY,
  label TEXT,
  vendor TEXT,
  category TEXT,
  risk TEXT,
  notes TEXT,
  guest_clear INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE apks (
  id TEXT PRIMARY KEY,
  package TEXT,
  label TEXT,
  version_name TEXT,
  version_code INTEGER,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  notes TEXT,
  uploaded_at INTEGER NOT NULL
);

CREATE TABLE app_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  required TEXT NOT NULL DEFAULT '[]',
  banned TEXT NOT NULL DEFAULT '[]',
  ban_action TEXT NOT NULL DEFAULT 'disable',
  kiosk_allowed TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE dns_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'domains',
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  policies TEXT NOT NULL DEFAULT '["balanced","strict"]',
  last_fetched INTEGER,
  last_count INTEGER,
  last_error TEXT,
  r2_key TEXT,
  sha256 TEXT
);

CREATE TABLE dns_rules (
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  category TEXT,
  vendor TEXT,
  policies TEXT NOT NULL DEFAULT '["balanced","strict"]',
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'user',
  notes TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (domain, scope_type, scope_id)
);

CREATE TABLE dns_policy_builds (
  policy TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  rules INTEGER NOT NULL,
  built_at INTEGER NOT NULL
);

CREATE TABLE domains (
  domain TEXT PRIMARY KEY,
  category TEXT,
  vendor TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  queries INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  would_block INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX domains_first_seen ON domains(first_seen);

CREATE TABLE dns_daily (
  day TEXT NOT NULL,
  site_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  category TEXT,
  queries INTEGER NOT NULL,
  blocked INTEGER NOT NULL,
  would_block INTEGER NOT NULL,
  PRIMARY KEY (day, device_id, domain)
);
CREATE INDEX dns_daily_site ON dns_daily(site_id, day);
CREATE INDEX dns_daily_domain ON dns_daily(domain);

CREATE TABLE dns_hourly (
  hour INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  queries INTEGER NOT NULL,
  blocked INTEGER NOT NULL,
  would_block INTEGER NOT NULL,
  cats TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (hour, device_id)
);
CREATE INDEX dns_hourly_site ON dns_hourly(site_id, hour);

CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  trigger TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '{}',
  actions TEXT NOT NULL,
  last_run INTEGER,
  last_status TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  device_id TEXT,
  kind TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  result TEXT,
  actor TEXT,
  automation_id TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX jobs_site ON jobs(site_id, created_at);
CREATE INDEX jobs_created ON jobs(created_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  site_id TEXT,
  details TEXT
);
CREATE INDEX audit_at ON audit_log(at);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  type TEXT NOT NULL,
  site_id TEXT,
  device_id TEXT,
  title TEXT NOT NULL,
  details TEXT,
  dedupe_key TEXT UNIQUE,
  acknowledged_at INTEGER,
  resolved_at INTEGER
);
CREATE INDEX alerts_open ON alerts(resolved_at, at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE dot_certs (
  site_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL,
  not_after INTEGER,
  last_error TEXT,
  dns_record_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_releases (
  version TEXT PRIMARY KEY,
  amd64_key TEXT,
  amd64_sha256 TEXT,
  arm64_key TEXT,
  arm64_sha256 TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL
);
