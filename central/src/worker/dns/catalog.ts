import type { DnsCategory, DnsPolicyName } from '../../shared/types';

/**
 * Curated domain intelligence for media devices.
 * - `block` entries are added to the named policies on top of the community lists.
 * - `allow` entries carve out essentials (firmware updates, clocks, streaming CDNs)
 *   that broad community lists sometimes catch and that break TVs when blocked.
 * Each entry is also used to label observed traffic in the dashboard.
 */
export interface CatalogEntry {
  domain: string;
  action: 'block' | 'allow' | 'label';
  category: DnsCategory;
  vendor: string;
  policies?: DnsPolicyName[];
  notes?: string;
}

const B: DnsPolicyName[] = ['balanced', 'strict'];
const S: DnsPolicyName[] = ['strict'];

export const CATALOG: CatalogEntry[] = [
  // ---- Samsung -----------------------------------------------------------
  { domain: 'samsungacr.com', action: 'block', category: 'acr', vendor: 'Samsung', policies: B, notes: 'Samsung ACR log ingestion (what you watch)' },
  { domain: 'samsungcloud.tv', action: 'label', category: 'vendor', vendor: 'Samsung' },
  { domain: 'acr-au-prd.samsungcloud.tv', action: 'block', category: 'acr', vendor: 'Samsung', policies: B, notes: 'Samsung ACR (Australia)' },
  { domain: 'acr-eu-prd.samsungcloud.tv', action: 'block', category: 'acr', vendor: 'Samsung', policies: B },
  { domain: 'acr-us-prd.samsungcloud.tv', action: 'block', category: 'acr', vendor: 'Samsung', policies: B },
  { domain: 'acr0.samsungcloudsolution.com', action: 'block', category: 'acr', vendor: 'Samsung', policies: B, notes: 'Legacy ACR endpoint' },
  { domain: 'samsungads.com', action: 'block', category: 'ads', vendor: 'Samsung', policies: B, notes: 'Samsung Ads platform' },
  { domain: 'samsungads.adsmeasurement.com', action: 'block', category: 'ads', vendor: 'Samsung', policies: B },
  { domain: 'samsung-com.112.2o7.net', action: 'block', category: 'tracking', vendor: 'Samsung', policies: B },
  { domain: 'prderrordumphsm.samsungcloudsolution.com', action: 'block', category: 'telemetry', vendor: 'Samsung', policies: B, notes: 'Crash/error dumps' },
  { domain: 'gamespromotion.samsungcloudsolution.com', action: 'block', category: 'ads', vendor: 'Samsung', policies: B },
  { domain: 'notice.samsungcloudsolution.com', action: 'block', category: 'ads', vendor: 'Samsung', policies: S, notes: 'Promotional notices' },
  { domain: 'samsungcloudsolution.com', action: 'label', category: 'vendor', vendor: 'Samsung', notes: 'Smart Hub core services: blocking it all breaks apps' },
  { domain: 'samsungcloudsolution.net', action: 'label', category: 'vendor', vendor: 'Samsung' },
  { domain: 'time.samsungcloudsolution.com', action: 'allow', category: 'essential', vendor: 'Samsung', policies: B, notes: 'Clock sync; Plex/YouTube/Prime break without it' },
  { domain: 'configprd.samsungcloudsolution.net', action: 'allow', category: 'essential', vendor: 'Samsung', policies: B },
  { domain: 'lcprd1.samsungcloudsolution.net', action: 'allow', category: 'essential', vendor: 'Samsung', policies: B, notes: 'Connectivity check' },
  { domain: 'cdn.samsungcloudsolution.com', action: 'allow', category: 'update', vendor: 'Samsung', policies: B },
  { domain: 'otnprd8.samsungcloudsolution.net', action: 'allow', category: 'update', vendor: 'Samsung', policies: B },
  { domain: 'otnprd9.samsungcloudsolution.net', action: 'allow', category: 'update', vendor: 'Samsung', policies: B },
  { domain: 'otnprd10.samsungcloudsolution.net', action: 'allow', category: 'update', vendor: 'Samsung', policies: B },
  { domain: 'otnprd11.samsungcloudsolution.net', action: 'allow', category: 'update', vendor: 'Samsung', policies: B },
  { domain: 'samsungotn.net', action: 'allow', category: 'update', vendor: 'Samsung', policies: B, notes: 'Firmware updates' },
  { domain: 'otn.samsungcloudcdn.com', action: 'allow', category: 'update', vendor: 'Samsung', policies: B },
  { domain: 'samsungosp.com', action: 'label', category: 'vendor', vendor: 'Samsung' },
  { domain: 'samsungqbe.com', action: 'label', category: 'vendor', vendor: 'Samsung' },
  { domain: 'samsungtifa.com', action: 'block', category: 'ads', vendor: 'Samsung', policies: B, notes: 'Tizen advertising ID' },

  // ---- LG webOS ----------------------------------------------------------
  { domain: 'lgsmartad.com', action: 'block', category: 'ads', vendor: 'LG', policies: B, notes: 'LG Ad Solutions' },
  { domain: 'lgads.tv', action: 'block', category: 'ads', vendor: 'LG', policies: B },
  { domain: 'lgtvsdp.com', action: 'label', category: 'vendor', vendor: 'LG' },
  { domain: 'rdx2.lgtvsdp.com', action: 'block', category: 'telemetry', vendor: 'LG', policies: B },
  { domain: 'smartshare.lgtvsdp.com', action: 'block', category: 'telemetry', vendor: 'LG', policies: B },
  { domain: 'alphonso.tv', action: 'block', category: 'acr', vendor: 'Alphonso (LG)', policies: B, notes: 'ACR vendor used by LG "Live Plus"' },
  { domain: 'ngfts.lge.com', action: 'block', category: 'telemetry', vendor: 'LG', policies: S, notes: 'Fault reports; also content-store thumbnails' },
  { domain: 'aic-ngfts.lge.com', action: 'block', category: 'telemetry', vendor: 'LG', policies: B },
  { domain: 'snu.lge.com', action: 'allow', category: 'update', vendor: 'LG', policies: B, notes: 'Firmware updates' },
  { domain: 'lge.com', action: 'label', category: 'vendor', vendor: 'LG' },

  // ---- Other ACR vendors -------------------------------------------------
  { domain: 'samba.tv', action: 'block', category: 'acr', vendor: 'Samba TV', policies: B, notes: 'ACR vendor (Sony, TCL, Philips…)' },
  { domain: 'tvinteractive.tv', action: 'block', category: 'acr', vendor: 'Inscape (Vizio)', policies: B },
  { domain: 'inscape.tv', action: 'block', category: 'acr', vendor: 'Inscape (Vizio)', policies: B },
  { domain: 'gracenote.com', action: 'label', category: 'vendor', vendor: 'Gracenote', notes: 'Metadata/ACR; used for EPG on some TVs' },

  // ---- Google / Android TV ----------------------------------------------
  { domain: 'app-measurement.com', action: 'block', category: 'telemetry', vendor: 'Google (Firebase)', policies: B, notes: 'Firebase Analytics' },
  { domain: 'firebaselogging-pa.googleapis.com', action: 'block', category: 'telemetry', vendor: 'Google', policies: B },
  { domain: 'crashlyticsreports-pa.googleapis.com', action: 'block', category: 'telemetry', vendor: 'Google', policies: S },
  { domain: 'googleads.g.doubleclick.net', action: 'block', category: 'ads', vendor: 'Google', policies: B },
  { domain: 'pagead2.googlesyndication.com', action: 'block', category: 'ads', vendor: 'Google', policies: B },
  { domain: 'googleadservices.com', action: 'block', category: 'ads', vendor: 'Google', policies: B },
  { domain: 'play.googleapis.com', action: 'allow', category: 'essential', vendor: 'Google', policies: B, notes: 'Play Store / Play services' },
  { domain: 'android.clients.google.com', action: 'allow', category: 'essential', vendor: 'Google', policies: B },
  { domain: 'connectivitycheck.gstatic.com', action: 'allow', category: 'essential', vendor: 'Google', policies: B, notes: 'Android internet check' },
  { domain: 'clients3.google.com', action: 'allow', category: 'essential', vendor: 'Google', policies: B },
  { domain: 'time.android.com', action: 'allow', category: 'essential', vendor: 'Google', policies: B },
  { domain: 'youtube.com', action: 'allow', category: 'streaming', vendor: 'YouTube', policies: B },
  { domain: 'googlevideo.com', action: 'allow', category: 'streaming', vendor: 'YouTube', policies: B },
  { domain: 'ytimg.com', action: 'allow', category: 'streaming', vendor: 'YouTube', policies: B },

  // ---- NVIDIA Shield -----------------------------------------------------
  { domain: 'gfe.nvidia.com', action: 'label', category: 'vendor', vendor: 'NVIDIA' },
  { domain: 'events.gfe.nvidia.com', action: 'block', category: 'telemetry', vendor: 'NVIDIA', policies: B, notes: 'GeForce/Shield telemetry events' },
  { domain: 'telemetry.gfe.nvidia.com', action: 'block', category: 'telemetry', vendor: 'NVIDIA', policies: B },
  { domain: 'ota.nvidia.com', action: 'allow', category: 'update', vendor: 'NVIDIA', policies: B, notes: 'Shield firmware updates' },
  { domain: 'nvidia.com', action: 'label', category: 'vendor', vendor: 'NVIDIA' },

  // ---- Amazon ------------------------------------------------------------
  { domain: 'device-metrics-us.amazon.com', action: 'block', category: 'telemetry', vendor: 'Amazon', policies: B },
  { domain: 'device-metrics-us-2.amazon.com', action: 'block', category: 'telemetry', vendor: 'Amazon', policies: B },
  { domain: 'aax.amazon-adsystem.com', action: 'block', category: 'ads', vendor: 'Amazon', policies: B },
  { domain: 'amazon-adsystem.com', action: 'block', category: 'ads', vendor: 'Amazon', policies: B },

  // ---- Sonos -------------------------------------------------------------
  { domain: 'sonos.com', action: 'label', category: 'vendor', vendor: 'Sonos' },
  { domain: 'update.sonos.com', action: 'allow', category: 'update', vendor: 'Sonos', policies: B },

  // ---- Streaming services (labels + protect from broad lists) -----------
  { domain: 'netflix.com', action: 'allow', category: 'streaming', vendor: 'Netflix', policies: B },
  { domain: 'nflxvideo.net', action: 'allow', category: 'streaming', vendor: 'Netflix', policies: B },
  { domain: 'nflxso.net', action: 'allow', category: 'streaming', vendor: 'Netflix', policies: B },
  { domain: 'nflxext.com', action: 'allow', category: 'streaming', vendor: 'Netflix', policies: B },
  { domain: 'disneyplus.com', action: 'allow', category: 'streaming', vendor: 'Disney+', policies: B },
  { domain: 'bamgrid.com', action: 'allow', category: 'streaming', vendor: 'Disney+', policies: B },
  { domain: 'primevideo.com', action: 'allow', category: 'streaming', vendor: 'Prime Video', policies: B },
  { domain: 'aiv-cdn.net', action: 'allow', category: 'streaming', vendor: 'Prime Video', policies: B },
  { domain: 'stan.com.au', action: 'allow', category: 'streaming', vendor: 'Stan', policies: B },
  { domain: 'binge.com.au', action: 'allow', category: 'streaming', vendor: 'Binge', policies: B },
  { domain: 'kayosports.com.au', action: 'allow', category: 'streaming', vendor: 'Kayo', policies: B },
  { domain: 'iview.abc.net.au', action: 'allow', category: 'streaming', vendor: 'ABC iview', policies: B },
  { domain: 'sbs.com.au', action: 'allow', category: 'streaming', vendor: 'SBS', policies: B },
  { domain: 'plex.tv', action: 'allow', category: 'streaming', vendor: 'Plex', policies: B },
  { domain: 'spotify.com', action: 'allow', category: 'streaming', vendor: 'Spotify', policies: B },
  { domain: 'scdn.co', action: 'allow', category: 'streaming', vendor: 'Spotify', policies: B },
];

export interface ListSource {
  id: string; name: string; url: string; format: 'domains' | 'hosts' | 'adblock'; category: DnsCategory; policies: DnsPolicyName[];
}

/** Community-maintained sources fetched daily by the cron (stored in R2, compiled per policy). */
export const DEFAULT_LISTS: ListSource[] = [
  { id: 'perflyst-smarttv', name: 'Perflyst Smart TV', url: 'https://raw.githubusercontent.com/Perflyst/PiHoleBlocklist/master/SmartTV.txt', format: 'domains', category: 'telemetry', policies: ['balanced', 'strict'] },
  { id: 'perflyst-android', name: 'Perflyst Android tracking', url: 'https://raw.githubusercontent.com/Perflyst/PiHoleBlocklist/master/android-tracking.txt', format: 'domains', category: 'tracking', policies: ['balanced', 'strict'] },
  { id: 'hagezi-samsung', name: 'HaGeZi native Samsung', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/native.samsung-onlydomains.txt', format: 'domains', category: 'telemetry', policies: ['balanced', 'strict'] },
  { id: 'hagezi-lgwebos', name: 'HaGeZi native LG webOS', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/native.lgwebos-onlydomains.txt', format: 'domains', category: 'telemetry', policies: ['balanced', 'strict'] },
  { id: 'hagezi-amazon', name: 'HaGeZi native Amazon', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/native.amazon-onlydomains.txt', format: 'domains', category: 'telemetry', policies: ['strict'] },
  { id: 'hagezi-light', name: 'HaGeZi Light (ads/trackers)', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/light-onlydomains.txt', format: 'domains', category: 'ads', policies: ['balanced'] },
  { id: 'hagezi-pro-mini', name: 'HaGeZi Pro mini (ads/trackers)', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro.mini-onlydomains.txt', format: 'domains', category: 'ads', policies: ['strict'] },
];

/** Known Android TV packages: labels, categories, and guest-reset defaults. */
export const APP_CATALOG: { package: string; label: string; vendor?: string; category: string; risk?: string; guest_clear?: boolean; notes?: string }[] = [
  { package: 'com.netflix.ninja', label: 'Netflix', category: 'streaming', guest_clear: true },
  { package: 'com.google.android.youtube.tv', label: 'YouTube', category: 'streaming', guest_clear: true },
  { package: 'com.google.android.youtube.tvunplugged', label: 'YouTube TV', category: 'streaming', guest_clear: true },
  { package: 'com.google.android.youtube.tvmusic', label: 'YouTube Music', category: 'streaming', guest_clear: true },
  { package: 'com.amazon.amazonvideo.livingroom', label: 'Prime Video', category: 'streaming', guest_clear: true },
  { package: 'com.disney.disneyplus', label: 'Disney+', category: 'streaming', guest_clear: true },
  { package: 'com.wbd.stream', label: 'Max', category: 'streaming', guest_clear: true },
  { package: 'com.apple.atve.androidtv.appletv', label: 'Apple TV', category: 'streaming', guest_clear: true },
  { package: 'com.cbs.ott', label: 'Paramount+', category: 'streaming', guest_clear: true },
  { package: 'au.com.stan.and', label: 'Stan', category: 'streaming', guest_clear: true },
  { package: 'au.com.streamotion.ares', label: 'Binge', category: 'streaming', guest_clear: true },
  { package: 'au.com.kayosports.tv', label: 'Kayo Sports', category: 'streaming', guest_clear: true },
  { package: 'au.net.abc.iview', label: 'ABC iview', category: 'streaming', guest_clear: false },
  { package: 'com.spotify.tv.android', label: 'Spotify', category: 'streaming', guest_clear: true },
  { package: 'com.plexapp.android', label: 'Plex', category: 'streaming', guest_clear: true },
  { package: 'org.xbmc.kodi', label: 'Kodi', category: 'streaming' },
  { package: 'com.android.vending', label: 'Google Play Store', vendor: 'Google', category: 'system' },
  { package: 'com.google.android.gms', label: 'Google Play services', vendor: 'Google', category: 'system' },
  { package: 'com.google.android.katniss', label: 'Google app (Assistant)', vendor: 'Google', category: 'assistant', risk: 'microphone', notes: 'Voice search / "Hey Google"' },
  { package: 'com.google.android.tvlauncher', label: 'Android TV Home', vendor: 'Google', category: 'launcher' },
  { package: 'com.google.android.apps.tv.launcherx', label: 'Google TV Home', vendor: 'Google', category: 'launcher' },
  { package: 'com.google.android.tvrecommendations', label: 'Android TV recommendations', vendor: 'Google', category: 'bloat', risk: 'tracking' },
  { package: 'com.google.android.leanbacklauncher', label: 'Leanback Launcher', vendor: 'Google', category: 'launcher' },
  { package: 'com.google.android.backdrop', label: 'Ambient mode (Backdrop)', vendor: 'Google', category: 'bloat' },
  { package: 'com.google.android.apps.mediashell', label: 'Chromecast built-in', vendor: 'Google', category: 'system' },
  { package: 'com.google.android.play.games', label: 'Google Play Games', vendor: 'Google', category: 'bloat' },
  { package: 'com.google.android.videos', label: 'Google TV (Play Movies)', vendor: 'Google', category: 'bloat' },
  { package: 'com.nvidia.tegrazone3', label: 'NVIDIA Games', vendor: 'NVIDIA', category: 'bloat' },
  { package: 'com.nvidia.ota', label: 'NVIDIA system updates', vendor: 'NVIDIA', category: 'system' },
];
