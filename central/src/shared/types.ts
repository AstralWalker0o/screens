// Shared types between the Worker API and the dashboard UI.
// All timestamps are epoch milliseconds.

export type DeviceKind = 'android' | 'samsung' | 'lg' | 'sonos' | 'other';
export type DeviceStatus = 'online' | 'standby' | 'offline' | 'unauthorized' | 'pairing' | 'unknown';
export type DnsMode = 'enforce' | 'monitor' | 'off' | 'bypass';
export type DnsPolicyName = 'balanced' | 'strict' | 'monitor';
export type DnsCategory =
  | 'acr' | 'ads' | 'telemetry' | 'tracking' | 'malware'
  | 'update' | 'streaming' | 'essential' | 'vendor' | 'unknown';
export type SiteKind = 'residential' | 'rental' | 'business';
export type Severity = 'info' | 'warning' | 'critical';

export interface Me { email: string; name?: string; dev?: boolean }

export interface Client {
  id: string; name: string; contact?: string | null; notes?: string | null;
  created_at: number; site_count?: number; device_count?: number;
}

export interface GatewayInterface { name: string; mac: string; addrs: string[]; up: boolean; multicast: boolean }

export interface GatewayMetrics {
  uptime_s?: number; load?: number[]; mem?: { total: number; available: number };
  dns?: { queries: number; blocked: number; would_block: number; cache_hits: number; upstream_errors: number; qps_1m: number };
  mdns?: { reflected: number; filtered: number; rate_limited: number; ssdp_relayed: number };
}

export interface Gateway {
  id: string; site_id: string; hostname?: string | null; version?: string | null;
  os?: string | null; arch?: string | null;
  status: 'online' | 'offline' | 'revoked';
  last_seen?: number | null; connected_at?: number | null; created_at: number;
  interfaces?: GatewayInterface[]; caps?: string[];
  metrics?: GatewayMetrics; dns_listening?: string[]; dot_listening?: string[];
  latest_version?: string | null;
}

export interface SiteSettings {
  monitor_days: number;              // days in monitor mode before auto-enforce
  default_policy: DnsPolicyName;     // policy new devices get after monitoring
  unknown_clients: DnsMode;          // DNS mode for clients that aren't adopted devices
  scan_cidrs: string[];              // extra subnets to scan (default: gateway subnets)
  dot_enabled: boolean;              // Android Private DNS via this site's DoT hostname
  guest: GuestSettings;
}

export interface GuestSettings {
  clear_packages: string[];          // Android packages to wipe on guest reset
  go_home: boolean;
  reboot: boolean;
  show_welcome_after_reset: boolean; // re-open the Screens Launcher welcome screen after a reset
  welcome: WelcomeConfig;
  kiosk: KioskConfig;
}

/** Welcome screen shown by the Screens Launcher (Android TV) on boot / after guest reset. */
export interface WelcomeConfig {
  enabled: boolean;
  show_on_boot: boolean;
  title: string;
  message: string;
  wifi: { ssid: string; password: string; security: 'WPA' | 'WEP' | 'nopass' } | null;
  sections: { title: string; body: string }[];
  contact: string;
  accent: string;                    // hex colour, e.g. #4F8EF7
}

/** Kiosk mode for the Screens Launcher: guests only see these apps. */
export interface KioskConfig {
  enabled: boolean;
  allowed: string[];                 // package names shown on the launcher
  pinned: string[];                  // shown first, in this order
  force_home: boolean;               // also disable the stock launcher (needed on some Google TV builds)
  pin_set?: boolean;                 // read-only: an exit PIN is configured
  pin?: string;                      // write-only: 4–8 digits to set, "" to clear
}

/** Sonos speaker facts (Device.facts for kind 'sonos'). */
export interface SonosFacts {
  uuid: string; room?: string; model_number?: string; display_version?: string; led?: boolean | null;
  now_playing?: { state?: string; title?: string; artist?: string; album?: string; art?: string; volume?: number; muted?: boolean };
  position?: { elapsed_s: number | null; duration_s: number | null };
  group?: { coordinator: string; is_coordinator: boolean; members: { uuid: string; name: string; ip: string | null }[] };
  zones?: { uuid: string; name: string; ip: string | null; coordinator: string }[];
  eq?: { bass: number; treble: number; loudness: boolean; night_mode?: boolean | string; speech?: boolean | string };
}

/** Screens Launcher state on an Android device (Device.facts.launcher). */
export interface LauncherState { installed: boolean; version?: string | null; config_sha?: string | null; is_home?: boolean; checked_at?: number }

export interface BulkCommandRequest { device_ids: string[]; command: string; args?: Record<string, unknown> }
export interface BulkCommandResult { results: { device_id: string; name?: string; ok: boolean; error?: string; data?: unknown }[] }

export interface SiteSummary {
  id: string; client_id: string; client_name?: string; name: string; slug: string;
  kind: SiteKind; timezone: string; address?: string | null;
  gateway_status: 'online' | 'offline' | 'none' | 'revoked';
  gateway_last_seen?: number | null;
  devices_total: number; devices_online: number;
  dns_queries_24h: number; dns_blocked_24h: number;
  alerts_open: number;
  created_at: number;
}

export interface SiteDetail extends SiteSummary {
  notes?: string | null;
  settings: SiteSettings;
  gateway?: Gateway | null;
  devices: Device[];
  dot_hostname?: string | null;
  dot_status?: string | null;
}

export interface Device {
  id: string; site_id: string; site_name?: string; kind: DeviceKind; name: string; room?: string | null;
  ip?: string | null; mac?: string | null; port?: number | null;
  manufacturer?: string | null; model?: string | null; os_version?: string | null;
  serial?: string | null; firmware?: string | null;
  status: DeviceStatus; power?: 'on' | 'standby' | 'off' | 'unknown' | null;
  current_app?: string | null; last_seen?: number | null;
  tags: string[];
  dns_mode: DnsMode; dns_policy: DnsPolicyName; monitor_until?: number | null;
  dns_allow: string[]; dns_block: string[];
  private_dns?: string | null;
  privacy_score?: number | null;
  facts: Record<string, unknown>;
  capabilities: DeviceCapability[];
  created_at: number; updated_at: number;
}

export type DeviceCapability =
  | 'remote' | 'text' | 'apps' | 'launch' | 'install' | 'uninstall' | 'disable' | 'clear'
  | 'screenshot' | 'tap' | 'shell' | 'reboot' | 'power' | 'volume' | 'private_dns'
  | 'media' | 'group' | 'toast' | 'guest_reset' | 'launcher' | 'led' | 'mute' | 'eq' | 'favorites' | 'mirror';

export interface Discovered {
  site_id: string; ip: string; mac?: string | null; kind_guess: DeviceKind | null;
  name?: string | null; model?: string | null; manufacturer?: string | null;
  hints: { ports?: number[]; mdns?: string[]; ssdp?: string[]; [k: string]: unknown };
  first_seen: number; last_seen: number; adopted_device_id?: string | null; ignored?: boolean;
}

export interface DeviceApp {
  package: string; label?: string | null; version_name?: string | null; version_code?: number | null;
  system: boolean; enabled: boolean; permissions: string[];
  category?: string | null; risk?: string | null; first_seen: number; last_seen: number;
  icon?: string | null;        // Samsung/LG may give an icon URL
  app_id?: string | null;      // Samsung/LG app id used for launch
}

export interface CommandRequest { command: string; args?: Record<string, unknown> }
export interface CommandResult { ok: boolean; data?: any; error?: string; job_id?: string }

export interface DnsLogEntry {
  ts: number; client: string; device_id?: string | null; device_name?: string | null;
  qname: string; qtype: string; action: 'allow' | 'block' | 'would_block';
  cat?: DnsCategory | null; rule?: string | null; rcode?: string; answers?: string[]; ms?: number; cached?: boolean;
}

export interface DnsSeriesPoint { t: number; queries: number; blocked: number; would_block: number }

export interface DnsDomainStat {
  domain: string; category?: DnsCategory | null; vendor?: string | null;
  queries: number; blocked: number; would_block: number; devices?: number;
  first_seen?: number; last_seen?: number; rule?: 'block' | 'allow' | null;
}

export interface DnsSummary {
  hours: number; queries: number; blocked: number; would_block: number;
  by_category: Partial<Record<DnsCategory, number>>;
  series: DnsSeriesPoint[];
  top_domains: DnsDomainStat[];
  top_blocked: DnsDomainStat[];
  by_device: { device_id: string; name: string; kind: DeviceKind; queries: number; blocked: number; would_block: number }[];
}

export interface PrivacyFactor { key: string; label: string; impact: number; detail?: string; status: 'good' | 'warn' | 'bad' }
export interface ChecklistItem { key: string; label: string; how: string; done: boolean; auto?: boolean }
export interface MicUsage { package: string; label?: string | null; last_access?: string | null; granted: boolean }

export interface DevicePrivacy {
  device_id: string; score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F';
  factors: PrivacyFactor[];
  checklist: ChecklistItem[];
  mic: MicUsage[];
  dns: DnsSummary;
  bypass_suspected: boolean;
}

export interface PrivacyOverview {
  devices: { device_id: string; name: string; site_id: string; site_name: string; kind: DeviceKind; score: number; grade: string; bypass_suspected: boolean; acr_24h: number }[];
  fleet: DnsSummary;
  new_domains: DnsDomainStat[];
  /** Viewing-tracking (ACR) lookups in the last 7 days, grouped by vendor. */
  acr_by_vendor: { vendor: string; attempts: number; blocked: number; devices: number }[];
}

export interface DnsRule {
  domain: string; action: 'block' | 'allow'; category?: DnsCategory | null; vendor?: string | null;
  policies: DnsPolicyName[]; scope_type: 'global' | 'client' | 'site'; scope_id: string;
  source: 'curated' | 'user'; notes?: string | null; created_at: number;
}

export interface DnsList {
  id: string; name: string; url: string; format: 'domains' | 'hosts' | 'adblock'; category: DnsCategory;
  enabled: boolean; policies: DnsPolicyName[];
  last_fetched?: number | null; last_count?: number | null; last_error?: string | null;
}

export interface DnsPolicyBuild { policy: DnsPolicyName; sha256: string; rules: number; built_at: number }

/** A network leg the gateway manages: a VLAN sub-interface on a trunked NIC, or an extra NIC the host left unconfigured. */
export interface NetIfaceConfig {
  kind: 'vlan' | 'existing';
  parent?: string;              // vlan: the trunked NIC (e.g. "eth0")
  vlan?: number;                // vlan: 1–4094
  name?: string;                // existing: the NIC to configure (e.g. "ens19")
  mode: 'dhcp' | 'static';
  address?: string;             // static: CIDR, e.g. "10.10.50.5/24"
  label?: string;               // free text shown in the dashboard ("IoT", "Main")
}
export interface NetConfig { interfaces: NetIfaceConfig[] }
export interface NetIfaceStatus {
  name: string; kind: 'vlan' | 'existing'; parent?: string; vlan?: number; mode: 'dhcp' | 'static';
  state: 'up' | 'acquiring' | 'error'; addrs: string[]; error?: string; lease_at?: number; expires?: number;
}
export interface NetworkState {
  supported: boolean;            // the gateway's agent can manage interfaces (cap "netcfg")
  gateway_online: boolean;
  config: NetConfig;
  status: NetIfaceStatus[];      // live (or last known) state of each managed leg
  errors: string[];
  host: GatewayInterface[];      // every interface the gateway sees, managed or not
  updated_at: number | null;
}

export interface MdnsRule { from: string; to: string[]; allow: string[]; deny: string[] }
export interface MdnsConfig {
  enabled: boolean; interfaces: string[]; rules: MdnsRule[];
  ssdp: { enabled: boolean; rules: { from: string; to: string[] }[] };
  rate_limit_pps: number; track_services: boolean;
}
export interface MdnsService { service: string; instance: string; host?: string; addrs?: string[]; port?: number; iface?: string; last_seen: number }
export interface MdnsStatus {
  enabled: boolean;
  interfaces: { name: string; rx: number; tx: number; dropped: number }[];
  services: MdnsService[];
  counters: { reflected: number; filtered: number; rate_limited: number; ssdp_relayed: number };
}

export interface Apk {
  id: string; package?: string | null; label?: string | null; version_name?: string | null; version_code?: number | null;
  sha256: string; size: number; notes?: string | null; uploaded_at: number;
}

export interface AppPolicy {
  id: string; name: string; scope_type: 'global' | 'client' | 'site' | 'device'; scope_id?: string | null;
  required: { package: string; apk_id?: string | null }[];
  banned: string[]; ban_action: 'disable' | 'uninstall';
  kiosk_allowed?: string[] | null;
  enabled: boolean; created_at: number;
}

export type AutomationTrigger =
  | { type: 'schedule'; cron: string; timezone?: string }
  | { type: 'event'; event: AutomationEvent };
export type AutomationEvent =
  | 'device.offline' | 'device.online' | 'app.installed' | 'gateway.offline' | 'gateway.online'
  | 'privacy.acr_detected' | 'dns.bypass_suspected';
export type AutomationAction =
  | { type: 'command'; command: string; args?: Record<string, unknown> }
  | { type: 'guest_reset' }
  | { type: 'enforce_apps' }
  | { type: 'dns_mode'; mode: DnsMode }
  | { type: 'alert'; severity: Severity; title: string }
  | { type: 'delay'; seconds: number };
export interface AutomationTarget { site_ids?: string[]; kinds?: DeviceKind[]; device_ids?: string[]; tags?: string[] }

export interface Automation {
  id: string; name: string; enabled: boolean;
  scope_type: 'global' | 'client' | 'site'; scope_id?: string | null;
  trigger: AutomationTrigger; target: AutomationTarget; actions: AutomationAction[];
  last_run?: number | null; last_status?: string | null; created_at: number;
}

export interface Job {
  id: string; site_id?: string | null; device_id?: string | null; kind: string;
  params: Record<string, unknown>; status: 'queued' | 'running' | 'ok' | 'error';
  result?: any; actor?: string | null; automation_id?: string | null;
  created_at: number; finished_at?: number | null;
  site_name?: string | null; device_name?: string | null;
}

export interface Alert {
  id: string; at: number; severity: Severity; type: string;
  site_id?: string | null; device_id?: string | null; title: string; details?: string | null;
  acknowledged_at?: number | null; resolved_at?: number | null;
  site_name?: string | null; device_name?: string | null;
}

export interface AuditEntry {
  id: number; at: number; actor: string; action: string; target_type?: string | null; target_id?: string | null;
  site_id?: string | null; details?: any;
}

export interface Overview {
  counts: {
    clients: number; sites: number; gateways_online: number; gateways_total: number;
    devices_total: number; devices_online: number; devices_by_kind: Partial<Record<DeviceKind, number>>;
    alerts_open: number;
  };
  dns: DnsSummary;
  sites: SiteSummary[];
  privacy_worst: PrivacyOverview['devices'];
  alerts: Alert[];
  recent_jobs: Job[];
}

export interface AppSettings {
  dot_base_domain?: string | null;   // e.g. dns.screens.supercluster.au
  default_monitor_days: number;
  default_policy: DnsPolicyName;
  dns_log_retention_days: number;
  agent_latest_version?: string | null;
  /** True when a Cloudflare DNS-edit token is stored (needed for Android Private DNS certificates). */
  cf_dns_token_set?: boolean;
  /** Write-only: send to store/replace the token (never returned). Empty string removes it. */
  cf_dns_token?: string;
}

export interface EnrollResult { token: string; expires_at: number; command: string; install_url: string }

// Live events pushed over the per-site WebSocket (/api/sites/:id/live)
export type LiveEvent =
  | { type: 'dns'; entries: DnsLogEntry[] }
  | { type: 'device'; device: Partial<Device> & { id: string } }
  | { type: 'gateway'; status: 'online' | 'offline'; gateway?: Partial<Gateway> }
  | { type: 'job'; job: Job }
  | { type: 'alert'; alert: Alert }
  | { type: 'network'; status: NetIfaceStatus[] };

export interface Paged<T> { items: T[]; next?: string | null }

/** GET /api/version: what's deployed and whether the fleet is up to date. */
export interface VersionInfo {
  version: string; build_sha: string; built_at: string | null;
  gateway: { latest: string | null; up_to_date: number; total: number; sites: { site_id: string; site_name: string; version: string | null; status: string; up_to_date: boolean }[] };
  launcher: { latest: string | null; installed: number; up_to_date: number };
}
