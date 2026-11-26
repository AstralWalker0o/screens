-- Screens Launcher v2 (docs/LAUNCHER-V2.md): home-screen layouts and their images.

-- A layout is the `home` object of config v2 plus a name and an optional accent.
-- site_id NULL = a fleet template any site can use or copy.
CREATE TABLE launcher_layouts (
  id TEXT PRIMARY KEY,
  site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config TEXT NOT NULL,          -- {"home": {...}, "accent": "#RRGGBB" | null}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX launcher_layouts_site ON launcher_layouts(site_id);

-- Which layout a site's boxes show (NULL = the classic v1 grid), and per-box overrides.
ALTER TABLE sites ADD COLUMN launcher_layout_id TEXT;
ALTER TABLE devices ADD COLUMN launcher_layout_id TEXT;

-- Wallpapers and card art, content-addressed by SHA-256. Bytes live in R2 at launcher/assets/<sha>.<ext>.
CREATE TABLE launcher_assets (
  sha256 TEXT PRIMARY KEY,
  ext TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  r2_key TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  uploaded_by TEXT
);
