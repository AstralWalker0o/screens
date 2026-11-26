// Typed client for the Screens central REST API (docs/API.md).
// In mock mode (localStorage.mock === '1' or ?mock=1) requests are answered by
// ./mock, which is loaded on demand so it never ships in the production path.

import type {
  Alert, Apk, AppPolicy, AppSettings, AuditEntry, Automation, Client, CommandRequest, CommandResult, Device,
  DeviceApp, DevicePrivacy, Discovered, DnsDomainStat, DnsList, DnsLogEntry, DnsPolicyBuild, DnsRule, DnsSummary,
  EnrollResult, Gateway, GatewayInterface, Job, LiveEvent, MdnsConfig, MdnsStatus, Me, Overview, PrivacyOverview,
  SiteDetail, SiteKind, SiteSummary, DeviceKind, BulkCommandRequest, BulkCommandResult, SiteSettings, GuestSettings,
} from '../shared/types';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function detectMock(): boolean {
  try {
    const q = new URLSearchParams(location.search).get('mock');
    if (q === '1') localStorage.setItem('mock', '1');
    if (q === '0') localStorage.removeItem('mock');
    return q === '1' || localStorage.getItem('mock') === '1';
  } catch {
    return new URLSearchParams(location.search).get('mock') === '1';
  }
}

export const MOCK = detectMock();

export function setMockMode(on: boolean) {
  try {
    if (on) localStorage.setItem('mock', '1');
    else localStorage.removeItem('mock');
  } catch {
    /* ignore */
  }
  const u = new URL(location.href);
  u.searchParams.delete('mock');
  location.href = u.toString();
}

type MockModule = typeof import('./mock');
let mockMod: Promise<MockModule> | null = null;
function mock(): Promise<MockModule> {
  mockMod ??= import('./mock');
  return mockMod;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (MOCK) {
    const m = await mock();
    return (await m.handle(method, path, body)) as T;
  }
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined && !isForm ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach Screens. Check your internet connection.');
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = res.statusText || 'Request failed';
    if (ct.includes('json')) {
      try {
        const j = (await res.json()) as { error?: string; message?: string };
        code = j.error ?? code;
        message = j.message ?? message;
      } catch {
        /* keep defaults */
      }
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  if (!ct.includes('json')) {
    // Cloudflare Access answers an expired session with its HTML login page.
    if (ct.includes('html')) throw new ApiError(401, 'session_expired', 'Your sign-in has expired. Reload the page to sign in again.');
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
}

const get = <T,>(p: string) => request<T>('GET', p);
const post = <T,>(p: string, b?: unknown) => request<T>('POST', p, b ?? {});
const put = <T,>(p: string, b: unknown) => request<T>('PUT', p, b);
const patch = <T,>(p: string, b: unknown) => request<T>('PATCH', p, b);
const del = <T,>(p: string) => request<T>('DELETE', p);

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
const enc = encodeURIComponent;

export type Ok = { ok: boolean };
export type GatewayWithLogs = Gateway & { logs: string[] };
export type MdnsState = { config: MdnsConfig; status: MdnsStatus | null; interfaces: GatewayInterface[] };
export type GuestResetResult = { results: { device_id: string; ok: boolean; detail: string }[] };
/** One row of GET /api/sites/:id/apps — the union of apps on a site's devices. */
export interface SiteApp { package: string; label: string | null; system: boolean; category: string | null; risk: string | null; devices: number; kinds: DeviceKind[] }
export type DnsLogQuery = { device_id?: string; q?: string; action?: string; limit?: number; before?: number };

export const api = {
  me: () => get<Me>('/api/me'),
  overview: () => get<Overview>('/api/overview'),

  clients: {
    list: () => get<Client[]>('/api/clients'),
    create: (b: { name: string; contact?: string; notes?: string }) => post<Client>('/api/clients', b),
    update: (id: string, b: Partial<Client>) => patch<Client>(`/api/clients/${enc(id)}`, b),
    remove: (id: string) => del<Ok>(`/api/clients/${enc(id)}`),
  },

  sites: {
    list: (client_id?: string) => get<SiteSummary[]>(`/api/sites${qs({ client_id })}`),
    get: (id: string) => get<SiteDetail>(`/api/sites/${enc(id)}`),
    create: (b: { client_id: string; name: string; kind: SiteKind; timezone: string; address?: string }) => post<SiteDetail>('/api/sites', b),
    /** Partial update; `settings` (and `settings.guest`) merge server-side. */
    update: (id: string, b: Partial<Omit<SiteDetail, 'settings'>> & { settings?: Partial<Omit<SiteSettings, 'guest'>> & { guest?: Partial<GuestSettings> } }) =>
      patch<SiteDetail>(`/api/sites/${enc(id)}`, b),
    remove: (id: string) => del<Ok>(`/api/sites/${enc(id)}`),
    enroll: (id: string) => post<EnrollResult>(`/api/sites/${enc(id)}/enroll`),
    gateway: (id: string) => get<GatewayWithLogs>(`/api/sites/${enc(id)}/gateway`),
    gatewayAction: (id: string, action: 'restart' | 'update' | 'revoke') => post<Ok>(`/api/sites/${enc(id)}/gateway/${action}`),
    apps: (id: string) => get<SiteApp[]>(`/api/sites/${enc(id)}/apps`),
    discover: (id: string) => post<Discovered[]>(`/api/sites/${enc(id)}/discover`),
    discovered: (id: string) => get<Discovered[]>(`/api/sites/${enc(id)}/discovered`),
    adopt: (id: string, b: { ip: string; kind: DeviceKind; name: string; room?: string; port?: number }) => post<Device>(`/api/sites/${enc(id)}/adopt`, b),
    ignore: (id: string, ip: string) => post<Ok>(`/api/sites/${enc(id)}/discovered/${enc(ip)}/ignore`),
    guestReset: (id: string, device_ids?: string[]) => post<GuestResetResult>(`/api/sites/${enc(id)}/guest-reset`, device_ids ? { device_ids } : {}),
    mdns: (id: string) => get<MdnsState>(`/api/sites/${enc(id)}/mdns`),
    saveMdns: (id: string, cfg: MdnsConfig) => put<Ok>(`/api/sites/${enc(id)}/mdns`, cfg),
    dnsLog: (id: string, q: DnsLogQuery = {}) => get<DnsLogEntry[]>(`/api/sites/${enc(id)}/dns/log${qs({ limit: 200, ...q })}`),
    dnsSummary: (id: string, hours = 24) => get<DnsSummary>(`/api/sites/${enc(id)}/dns/summary${qs({ hours })}`),
  },

  devices: {
    list: (p: { site_id?: string; kind?: DeviceKind } = {}) => get<Device[]>(`/api/devices${qs(p)}`),
    get: (id: string) => get<Device>(`/api/devices/${enc(id)}`),
    update: (id: string, b: Partial<Pick<Device, 'name' | 'room' | 'tags' | 'ip' | 'port' | 'dns_mode' | 'dns_policy' | 'dns_allow' | 'dns_block'>>) =>
      patch<Device>(`/api/devices/${enc(id)}`, b),
    remove: (id: string) => del<Ok>(`/api/devices/${enc(id)}`),
    command: (id: string, command: string, args?: Record<string, unknown>) =>
      post<CommandResult>(`/api/devices/${enc(id)}/command`, { command, args } satisfies CommandRequest),
    bulk: (b: BulkCommandRequest) => post<BulkCommandResult>('/api/devices/bulk', b),
    apps: (id: string) => get<DeviceApp[]>(`/api/devices/${enc(id)}/apps`),
    privacy: (id: string) => get<DevicePrivacy>(`/api/devices/${enc(id)}/privacy`),
    setChecklist: (id: string, key: string, done: boolean) => put<Ok>(`/api/devices/${enc(id)}/privacy/checklist`, { key, done }),
    /** Latest screenshot as an object/data URL, or null when none exists yet (404). */
    screenshot: async (id: string): Promise<string | null> => {
      if (MOCK) return (await mock()).screenshotFor(id);
      const res = await fetch(`/api/devices/${enc(id)}/screenshot?t=${Date.now()}`, { credentials: 'same-origin' });
      if (res.status === 404) return null;
      if (!res.ok) throw new ApiError(res.status, `http_${res.status}`, 'Could not load the screenshot');
      return URL.createObjectURL(await res.blob());
    },
  },

  privacy: () => get<PrivacyOverview>('/api/privacy'),

  dns: {
    domains: (p: { q?: string; category?: string; site_id?: string; days?: number; limit?: number } = {}) =>
      get<DnsDomainStat[]>(`/api/dns/domains${qs({ days: 7, limit: 200, ...p })}`),
    rules: () => get<DnsRule[]>('/api/dns/rules'),
    addRule: (r: Omit<DnsRule, 'created_at' | 'source'>) => post<DnsRule>('/api/dns/rules', r),
    deleteRule: (r: Pick<DnsRule, 'domain' | 'scope_type' | 'scope_id'>) =>
      del<Ok>(`/api/dns/rules${qs({ domain: r.domain, scope_type: r.scope_type, scope_id: r.scope_id })}`),
    lists: () => get<{ lists: DnsList[]; builds: DnsPolicyBuild[] }>('/api/dns/lists'),
    updateList: (id: string, b: Partial<Pick<DnsList, 'enabled' | 'policies'>>) => patch<DnsList>(`/api/dns/lists/${enc(id)}`, b),
    rebuild: () => post<{ builds: DnsPolicyBuild[] }>('/api/dns/rebuild'),
  },

  apks: {
    list: () => get<Apk[]>('/api/apks'),
    upload: (file: File, meta: { package?: string; label?: string; notes?: string } = {}) => {
      const fd = new FormData();
      fd.set('file', file);
      for (const [k, v] of Object.entries(meta)) if (v) fd.set(k, v);
      return request<Apk>('POST', '/api/apks', fd);
    },
    remove: (id: string) => del<Ok>(`/api/apks/${enc(id)}`),
  },

  appPolicies: {
    list: () => get<AppPolicy[]>('/api/app-policies'),
    create: (p: Omit<AppPolicy, 'id' | 'created_at'>) => post<AppPolicy>('/api/app-policies', p),
    update: (id: string, p: Partial<AppPolicy>) => patch<AppPolicy>(`/api/app-policies/${enc(id)}`, p),
    remove: (id: string) => del<Ok>(`/api/app-policies/${enc(id)}`),
  },

  automations: {
    list: () => get<Automation[]>('/api/automations'),
    create: (a: Omit<Automation, 'id' | 'created_at' | 'last_run' | 'last_status'>) => post<Automation>('/api/automations', a),
    update: (id: string, a: Partial<Automation>) => patch<Automation>(`/api/automations/${enc(id)}`, a),
    remove: (id: string) => del<Ok>(`/api/automations/${enc(id)}`),
    run: (id: string) => post<{ ok: boolean; jobs: Job[] }>(`/api/automations/${enc(id)}/run`),
  },

  jobs: (p: { site_id?: string; device_id?: string; limit?: number } = {}) => get<Job[]>(`/api/jobs${qs(p)}`),
  alerts: (open?: boolean) => get<Alert[]>(`/api/alerts${qs({ open: open ? 1 : undefined })}`),
  ackAlert: (id: string) => post<Ok>(`/api/alerts/${enc(id)}/ack`),
  audit: (p: { limit?: number; site_id?: string } = {}) => get<AuditEntry[]>(`/api/audit${qs(p)}`),
  settings: {
    get: () => get<AppSettings>('/api/settings'),
    save: (s: Partial<AppSettings>) => put<AppSettings>('/api/settings', s),
  },
};

// ---------------------------------------------------------------------------
// Live events: per-site WebSocket with exponential backoff (1 s → 30 s, ±20 %).

export type LiveStatus = 'connecting' | 'open' | 'closed';

export function openLive(siteId: string, onEvent: (e: LiveEvent) => void, onStatus?: (s: LiveStatus) => void): () => void {
  let closed = false;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopMock: (() => void) | null = null;

  if (MOCK) {
    onStatus?.('connecting');
    mock().then((m) => {
      if (closed) return;
      onStatus?.('open');
      stopMock = m.live(siteId, onEvent);
    });
    return () => {
      closed = true;
      stopMock?.();
    };
  }

  const connect = () => {
    if (closed) return;
    onStatus?.('connecting');
    const url = `${location.origin.replace(/^http/, 'ws')}/api/sites/${enc(siteId)}/live`;
    try {
      ws = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    let openedAt = 0;
    ws.onopen = () => {
      openedAt = Date.now();
      onStatus?.('open');
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(typeof m.data === 'string' ? m.data : '') as LiveEvent);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      ws = null;
      if (closed) return;
      if (openedAt && Date.now() - openedAt > 60_000) attempt = 0;
      onStatus?.('closed');
      schedule();
    };
    ws.onerror = () => ws?.close();
  };
  const schedule = () => {
    const base = Math.min(30_000, 1000 * 2 ** attempt++);
    const jitter = base * (0.8 + Math.random() * 0.4);
    timer = setTimeout(connect, jitter);
  };
  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
