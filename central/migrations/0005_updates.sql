-- App update manager for Android TV boxes (central/src/worker/updates, docs/UPDATES.md).
-- New tables only: builds themselves stay in `apks` (+ R2), install jobs in `jobs`.

-- What Screens learnt about each library APK by reading it (native ABIs, signing certificates).
CREATE TABLE update_apk_info (
  apk_id TEXT PRIMARY KEY,
  package TEXT,                     -- read from AndroidManifest.xml (must match apks.package to be offered)
  version_code INTEGER,             -- long versionCode (versionCodeMajor << 32 | versionCode)
  version_name TEXT,
  abis TEXT NOT NULL DEFAULT '[]',
  min_sdk INTEGER,
  signing TEXT,                     -- JSON ApkSigning (certificate SHA-256 + dumpsys hash, rotation lineage)
  source TEXT NOT NULL DEFAULT 'library',   -- 'library' (uploaded) | 'github'
  origin TEXT,                      -- github: "owner/repo#<asset id>"
  tag TEXT,                         -- github: release tag
  error TEXT,                       -- why it couldn't be read
  inspected_at INTEGER NOT NULL
);

-- GitHub releases as an update source, one per package.
CREATE TABLE update_sources (
  package TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'github',
  repo TEXT NOT NULL,
  asset_pattern TEXT NOT NULL DEFAULT '*.apk',
  abi_patterns TEXT NOT NULL DEFAULT '{}',
  include_prereleases INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  signer_sha256 TEXT,               -- trusted signing key, learnt from the first import
  etag TEXT,
  last_checked INTEGER,
  last_status TEXT,
  last_error TEXT,
  latest_tag TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- auto | notify | pin, per package: a fleet default and per-site overrides.
CREATE TABLE update_policies (
  package TEXT NOT NULL,
  scope_type TEXT NOT NULL,         -- 'fleet' | 'site'
  scope_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (package, scope_type, scope_id)
);

-- Per-site maintenance window (site local time) and preferred canary box.
CREATE TABLE update_sites (
  site_id TEXT PRIMARY KEY,
  window_start TEXT NOT NULL DEFAULT '03:00',
  window_end TEXT NOT NULL DEFAULT '05:00',
  canary_device_id TEXT,
  updated_at INTEGER NOT NULL
);

-- Per-box facts the updater reads over adb (processor ABIs) and the operator's build choice.
CREATE TABLE update_devices (
  device_id TEXT PRIMARY KEY,
  abis TEXT NOT NULL DEFAULT '[]',  -- ro.product.cpu.abilist, primary first
  sdk INTEGER,
  abi_override TEXT,
  probed_at INTEGER
);

-- Per box × sideloaded app: who installed it and which key signed it.
CREATE TABLE update_device_apps (
  device_id TEXT NOT NULL,
  package TEXT NOT NULL,
  version_code INTEGER,
  installer TEXT,                   -- installerPackageName (com.android.vending = Google Play)
  sig_hashes TEXT,                  -- JSON: dumpsys "signatures:[…]" (Java hashCode of each certificate)
  signer_sha256 TEXT,               -- JSON: SHA-256 of the signing certificate(s), read from the installed APK
  signer_vc INTEGER,                -- version_code signer_sha256 was read at
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, package)
);

-- A staged rollout of one version of one package at one site: canary first, then the rest.
CREATE TABLE update_rollouts (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  package TEXT NOT NULL,
  label TEXT,
  version_code INTEGER,
  version_name TEXT,
  trigger TEXT NOT NULL,            -- 'auto' | 'manual'
  status TEXT NOT NULL,             -- canary | rolling | done | failed | cancelled
  devices TEXT NOT NULL DEFAULT '[]',
  detail TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX update_rollouts_site ON update_rollouts(site_id, status, created_at);
CREATE INDEX update_rollouts_created ON update_rollouts(created_at);

-- Small key/value state (GitHub rate-limit backoff, last check).
CREATE TABLE update_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE INDEX jobs_kind ON jobs(kind, created_at);
