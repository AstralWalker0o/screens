import { DurableObject } from 'cloudflare:workers';
import type {
  Automation, AutomationAction, AutomationEvent, Device, DeviceKind, DevicePrivacy, Discovered, DnsLogEntry, DnsSummary, LiveEvent,
  MdnsConfig, MdnsStatus,
} from '../../shared/types';
import { adapterFor, DISCOVERY_MDNS, DISCOVERY_PORTS, fingerprint, parseSonosDescription, probeTarget, type RawHost } from '../adapters';
import type { AdapterCtx } from '../adapters/types';
import { AdapterError, xmlTag } from '../adapters/types';
import { classify } from '../dns/compile';
import { buildDnsConfig } from '../dns/config';
import { certNotAfter, issueCertificate, upsertRecord, zoneId } from '../acme/acme';
import type { Env } from '../env';
import { openJson, sealJson, signAgentUrl } from '../lib/crypto';
import {
  audit, createJob, finishJob, getAppSettings, raiseAlert, resolveAlert, type Row, siteMdns, siteSettings, toAutomation, toDevice, toDiscovered,
} from '../lib/db';
import { chunk, dayKey, hourKey, HttpError, normMac, now, parseJson, rid, sleep } from '../lib/util';
import { scoreDevice } from '../privacy/score';
import { RelayStream } from './stream';

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

const TICK_MS = 60_000;
const QUIET_COMMANDS = new Set(['key', 'text', 'tap', 'volume', 'mute', 'media', 'screenshot', 'refresh', 'apps', 'topology', 'mic_usage']);
const JOB_COMMANDS = new Set(['install', 'uninstall', 'guest_reset', 'reboot', 'private_dns', 'shell', 'clear', 'disable', 'enable', 'restore']);
const OFFLINE_AFTER_FAILS = 3;

export class SiteHub extends DurableObject<Env> {
  private sql: SqlStorage;
  private pending = new Map<string, Pending>();
  private streams = new Map<string, RelayStream>();
  private seq = 0;
  private names: Map<string, string> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS dnslog (ts INTEGER, client TEXT, device_id TEXT, qname TEXT, qtype TEXT, action TEXT, cat TEXT, rule TEXT, rcode TEXT, answers TEXT, ms INTEGER, cached INTEGER);
      CREATE INDEX IF NOT EXISTS dnslog_ts ON dnslog(ts);
      CREATE INDEX IF NOT EXISTS dnslog_dev ON dnslog(device_id, ts);
      CREATE TABLE IF NOT EXISTS agg_daily (day TEXT, device_id TEXT, domain TEXT, cat TEXT, q INTEGER, b INTEGER, w INTEGER, fq INTEGER DEFAULT 0, fb INTEGER DEFAULT 0, fw INTEGER DEFAULT 0, dirty INTEGER DEFAULT 1, PRIMARY KEY (day, device_id, domain));
      CREATE TABLE IF NOT EXISTS agg_hourly (hour INTEGER, device_id TEXT, q INTEGER, b INTEGER, w INTEGER, cats TEXT, dirty INTEGER DEFAULT 1, PRIMARY KEY (hour, device_id));
      CREATE TABLE IF NOT EXISTS gwlog (ts INTEGER, level TEXT, msg TEXT);
      CREATE TABLE IF NOT EXISTS mdns_services (service TEXT, instance TEXT, iface TEXT, host TEXT, addrs TEXT, port INTEGER, last_seen INTEGER, PRIMARY KEY (service, instance, iface));
      CREATE TABLE IF NOT EXISTS probe_fails (device_id TEXT PRIMARY KEY, n INTEGER);
      CREATE TABLE IF NOT EXISTS nonces (n TEXT PRIMARY KEY, ts INTEGER);
    `);
  }

  // ---------------------------------------------------------------- kv / identity
  private kv<T>(k: string, fallback: T): T {
    const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return r ? (JSON.parse(r.v as string) as T) : fallback;
  }
  private setKv(k: string, v: unknown) { this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }
  private get siteId(): string {
    const s = this.kv<string | null>('site_id', null);
    if (!s) throw new HttpError(500, 'hub_uninitialised', 'Site hub has no site id');
    return s;
  }
  private get origin(): string { return this.env.PUBLIC_URL || this.kv<string>('origin', 'http://localhost:5173'); }
  private remember(siteId: string, origin?: string | null) {
    if (this.kv<string | null>('site_id', null) !== siteId) this.setKv('site_id', siteId);
    if (origin && this.kv<string | null>('origin', null) !== origin) this.setKv('origin', origin);
  }
  /** Called by the Worker before any RPC so the hub knows which site it serves. */
  async init(siteId: string, origin?: string) { this.remember(siteId, origin); }

  // ---------------------------------------------------------------- websockets
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const siteId = req.headers.get('x-site-id');
    if (siteId) this.remember(siteId, req.headers.get('x-origin'));
    if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    if (url.pathname === '/agent') {
      const nonce = req.headers.get('x-nonce');
      if (nonce) {
        this.sql.exec('DELETE FROM nonces WHERE ts < ?', now() - 15 * 60_000);
        if (this.sql.exec('SELECT 1 FROM nonces WHERE n = ?', nonce).toArray().length) return new Response('nonce reused', { status: 401 });
        this.sql.exec('INSERT INTO nonces (n, ts) VALUES (?, ?)', nonce, now());
      }
      for (const old of this.ctx.getWebSockets('agent')) { try { old.close(4000, 'replaced by a newer connection'); } catch { /* */ } }
      const gatewayId = req.headers.get('x-gateway-id') ?? 'unknown';
      this.ctx.acceptWebSocket(pair[1], ['agent', gatewayId]);
      pair[1].serializeAttachment({ gateway_id: gatewayId, connected_at: now() });
      await this.scheduleTick(5_000);
    } else if (url.pathname === '/live') {
      this.ctx.acceptWebSocket(pair[1], ['live']);
    } else {
      return new Response('not found', { status: 404 });
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private agent(): WebSocket | null { return this.ctx.getWebSockets('agent')[0] ?? null; }
  get online(): boolean { return this.agent() !== null; }

  private sendFrame(frame: object) {
    const ws = this.agent();
    if (!ws) throw new HttpError(503, 'gateway_offline', 'The site gateway is offline');
    ws.send(JSON.stringify(frame));
  }

  private broadcast(evt: LiveEvent) {
    const sockets = this.ctx.getWebSockets('live');
    if (!sockets.length) return;
    const msg = JSON.stringify(evt);
    for (const ws of sockets) { try { ws.send(msg); } catch { /* closed */ } }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (!this.ctx.getTags(ws).includes('agent')) return; // live sockets are receive-only
    let frame: any;
    try { frame = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); } catch { return; }
    switch (frame.t) {
      case 'hello': await this.onHello(ws, frame); break;
      case 'res': {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.data ?? {});
        else p.reject(new AdapterError(frame.error?.code ?? 'failed', frame.error?.message ?? 'Gateway operation failed'));
        break;
      }
      case 'evt': await this.onEvent(frame.type, frame.data ?? {}); break;
      case 'stream': {
        const s = this.streams.get(frame.stream);
        if (!s) { if (frame.kind !== 'close') ws.send(JSON.stringify({ t: 'stream', stream: frame.stream, kind: 'close', code: 1011, reason: 'unknown stream' })); return; }
        if (frame.kind === 'close') s.remoteClosed('closed by device');
        else if (frame.kind === 'text') s.deliver(frame.data ?? '');
        else s.deliver(frame.data_b64 ?? '');
        break;
      }
      case 'ping': ws.send(JSON.stringify({ t: 'pong', ts: frame.ts })); break;
    }
  }

  async webSocketClose(ws: WebSocket) { await this.onSocketGone(ws); }
  async webSocketError(ws: WebSocket) { await this.onSocketGone(ws); }

  private async onSocketGone(ws: WebSocket) {
    if (!this.ctx.getTags(ws).includes('agent')) return;
    if (this.ctx.getWebSockets('agent').some((s) => s !== ws)) return; // replaced by a newer connection
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new AdapterError('unreachable', 'Gateway disconnected')); }
    this.pending.clear();
    for (const s of this.streams.values()) s.remoteClosed('gateway disconnected');
    const att = ws.deserializeAttachment() as { gateway_id?: string } | null;
    if (att?.gateway_id) await this.env.DB.prepare("UPDATE gateways SET status = 'offline', last_seen = ? WHERE id = ? AND status != 'revoked'").bind(now(), att.gateway_id).run();
    this.setKv('offline_since', now());
    this.broadcast({ type: 'gateway', status: 'offline' });
    await this.scheduleTick(3 * 60_000);
  }

  // ---------------------------------------------------------------- gateway RPC
  async gw<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const ws = this.agent();
    if (!ws) throw new HttpError(503, 'gateway_offline', 'The site gateway is offline');
    const id = `r${++this.seq}${Date.now().toString(36)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError('timeout', `Gateway did not answer ${op} in time`));
      }, timeoutMs + 3_000);
      this.pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ t: 'req', id, op, args, timeout_ms: timeoutMs })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(new AdapterError('unreachable', String(e))); }
    });
  }

  private async openWs(url: string, opts: { headers?: Record<string, string>; insecure_tls?: boolean } = {}) {
    const id = rid('s', 10);
    const s = new RelayStream(id, (f) => this.sendFrame(f), () => this.streams.delete(id));
    this.streams.set(id, s);
    try {
      await this.gw('ws.open', { stream: id, url, headers: opts.headers ?? {}, insecure_tls: opts.insecure_tls ?? true }, 15_000);
    } catch (e) {
      this.streams.delete(id);
      throw e;
    }
    return s;
  }

  // ---------------------------------------------------------------- hello / config
  private async onHello(ws: WebSocket, h: any) {
    const att = (ws.deserializeAttachment() ?? {}) as { gateway_id?: string };
    const gwId = att.gateway_id!;
    const info = { interfaces: h.interfaces ?? [], caps: h.caps ?? [], dns: h.dns ?? {}, adb_version: h.adb_version ?? null, started_at: h.started_at ?? null };
    await this.env.DB.prepare("UPDATE gateways SET status = 'online', hostname = ?, version = ?, os = ?, arch = ?, last_seen = ?, connected_at = ?, info = ? WHERE id = ?")
      .bind(h.hostname ?? null, h.version ?? null, h.os ?? null, h.arch ?? null, now(), now(), JSON.stringify(info), gwId).run();
    const site = await this.site();
    const mdns = siteMdns(site);
    const dns = await buildDnsConfig(this.env, this.siteId, this.origin);
    ws.send(JSON.stringify({
      t: 'welcome', site_id: this.siteId, server_time: now(),
      config: { dns, mdns, telemetry: { dns_batch_ms: 5000, metrics_ms: 60000, neighbors_ms: 300000 } },
    }));
    this.setKv('offline_since', null);
    await resolveAlert(this.env, `gw_offline:${this.siteId}`);
    this.broadcast({ type: 'gateway', status: 'online', gateway: { hostname: h.hostname, version: h.version } });
    this.ctx.waitUntil(this.fireEvent('gateway.online', {}));
  }

  private async site(): Promise<Row> {
    const s = await this.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(this.siteId).first<Row>();
    if (!s) throw new HttpError(404, 'not_found', 'Site not found');
    return s;
  }

  /** Re-send DNS config (devices/policies/rules changed). Safe to call when offline. */
  async pushDnsConfig(): Promise<boolean> {
    if (!this.online) return false;
    const cfg = await buildDnsConfig(this.env, this.siteId, this.origin);
    await this.gw('dns.configure', cfg as unknown as Record<string, unknown>, 20_000);
    this.names = null;
    return true;
  }

  async pushMdnsConfig(cfg: MdnsConfig): Promise<boolean> {
    if (!this.online) return false;
    await this.gw('mdns.configure', cfg as unknown as Record<string, unknown>, 20_000);
    return true;
  }

  // ---------------------------------------------------------------- events from the gateway
  private async deviceNames(): Promise<Map<string, string>> {
    if (this.names) return this.names;
    const rows = await this.env.DB.prepare('SELECT id, name FROM devices WHERE site_id = ?').bind(this.siteId).all<Row>();
    this.names = new Map(rows.results.map((r) => [r.id as string, r.name as string]));
    return this.names;
  }

  private async onEvent(type: string, data: any) {
    switch (type) {
      case 'dns.queries': await this.ingestDns(data.entries ?? []); break;
      case 'metrics': {
        this.setKv('metrics', data);
        const gwId = (this.agent()?.deserializeAttachment() as any)?.gateway_id;
        if (gwId) await this.env.DB.prepare("UPDATE gateways SET last_seen = ?, info = json_set(info, '$.metrics', json(?)) WHERE id = ?").bind(now(), JSON.stringify(data), gwId).run();
        break;
      }
      case 'neighbors': await this.reconcileNeighbors(data.entries ?? []); break;
      case 'mdns.services': {
        this.sql.exec('DELETE FROM mdns_services');
        for (const s of (data.services ?? []).slice(0, 2000)) {
          this.sql.exec('INSERT OR REPLACE INTO mdns_services (service, instance, iface, host, addrs, port, last_seen) VALUES (?,?,?,?,?,?,?)',
            s.service ?? '', s.instance ?? '', s.iface ?? '', s.host ?? null, JSON.stringify(s.addrs ?? []), s.port ?? null, s.last_seen ?? now());
        }
        break;
      }
      case 'log': {
        this.sql.exec('INSERT INTO gwlog (ts, level, msg) VALUES (?,?,?)', data.ts ?? now(), data.level ?? 'info', String(data.msg ?? '').slice(0, 2000));
        break;
      }
    }
  }

  private async ingestDns(entries: any[]) {
    if (!entries.length) return;
    const names = await this.deviceNames();
    const acrSeen = new Set<string>();
    const out: DnsLogEntry[] = [];
    for (const e of entries) {
      const qname = String(e.qname ?? '').toLowerCase().replace(/\.$/, '');
      if (!qname) continue;
      const deviceId = e.device_id || `ip:${e.client}`;
      const cat = e.cat || classify(qname).category || null;
      const action = e.action === 'block' || e.action === 'would_block' ? e.action : 'allow';
      const ts = Number(e.ts) || now();
      this.sql.exec('INSERT INTO dnslog (ts, client, device_id, qname, qtype, action, cat, rule, rcode, answers, ms, cached) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        ts, e.client ?? '', deviceId, qname, e.qtype ?? '', action, cat, e.rule ?? null, e.rcode ?? null, JSON.stringify((e.answers ?? []).slice(0, 8)), e.ms ?? null, e.cached ? 1 : 0);
      const b = action === 'block' ? 1 : 0, w = action === 'would_block' ? 1 : 0;
      this.sql.exec(`INSERT INTO agg_daily (day, device_id, domain, cat, q, b, w, dirty) VALUES (?,?,?,?,1,?,?,1)
        ON CONFLICT(day, device_id, domain) DO UPDATE SET q = q + 1, b = b + excluded.b, w = w + excluded.w, cat = COALESCE(excluded.cat, cat), dirty = 1`,
        dayKey(ts), deviceId, qname, cat, b, w);
      const hour = hourKey(ts);
      const prev = this.sql.exec('SELECT cats FROM agg_hourly WHERE hour = ? AND device_id = ?', hour, deviceId).toArray()[0];
      const cats = parseJson<Record<string, number>>(prev?.cats as string, {});
      if (cat) cats[cat] = (cats[cat] ?? 0) + 1;
      this.sql.exec(`INSERT INTO agg_hourly (hour, device_id, q, b, w, cats, dirty) VALUES (?,?,1,?,?,?,1)
        ON CONFLICT(hour, device_id) DO UPDATE SET q = q + 1, b = b + excluded.b, w = w + excluded.w, cats = excluded.cats, dirty = 1`,
        hour, deviceId, b, w, JSON.stringify(cats));
      if (cat === 'acr' && action !== 'block' && e.device_id) acrSeen.add(e.device_id);
      out.push({ ts, client: e.client, device_id: e.device_id ?? null, device_name: e.device_id ? names.get(e.device_id) ?? null : null, qname, qtype: e.qtype, action, cat, rule: e.rule, rcode: e.rcode, answers: e.answers, ms: e.ms, cached: !!e.cached });
    }
    this.broadcast({ type: 'dns', entries: out });
    for (const id of acrSeen) {
      const last = this.kv<number>(`acr_evt:${id}`, 0);
      if (now() - last > 6 * 3_600_000) {
        this.setKv(`acr_evt:${id}`, now());
        this.ctx.waitUntil(this.fireEvent('privacy.acr_detected', { device_id: id }));
      }
    }
  }

  private async reconcileNeighbors(entries: { ip: string; mac: string }[]) {
    this.setKv('neighbors', entries.slice(0, 1024));
    const devices = (await this.env.DB.prepare('SELECT id, ip, mac FROM devices WHERE site_id = ?').bind(this.siteId).all<Row>()).results;
    const byMac = new Map(entries.map((e) => [normMac(e.mac), e.ip]));
    const byIp = new Map(entries.map((e) => [e.ip, normMac(e.mac)]));
    let changed = false;
    for (const d of devices) {
      const mac = normMac(d.mac);
      if (mac && byMac.has(mac) && byMac.get(mac) !== d.ip) {
        // DHCP moved this device: follow it by MAC so DNS attribution and control keep working.
        await this.env.DB.prepare('UPDATE devices SET ip = ?, updated_at = ? WHERE id = ?').bind(byMac.get(mac), now(), d.id).run();
        changed = true;
      } else if (!mac && d.ip && byIp.get(d.ip)) {
        await this.env.DB.prepare('UPDATE devices SET mac = ?, updated_at = ? WHERE id = ?').bind(byIp.get(d.ip), now(), d.id).run();
      }
    }
    if (changed) await this.pushDnsConfig().catch(() => undefined);
  }

  // ---------------------------------------------------------------- devices
  private async deviceRow(id: string): Promise<Row> {
    const r = await this.env.DB.prepare('SELECT * FROM devices WHERE id = ? AND site_id = ?').bind(id, this.siteId).first<Row>();
    if (!r) throw new HttpError(404, 'not_found', 'Device not found');
    return r;
  }

  private makeCtx(row: Row): AdapterCtx {
    return {
      env: this.env, device: row, origin: this.origin,
      gw: (op, args, t) => this.gw(op, args, t),
      openWs: (url, opts) => this.openWs(url, opts),
      getSecrets: async <T extends object>() => openJson<T>(this.env.SECRETS_KEY, row.secrets, {} as T),
      setSecrets: async (v) => {
        row.secrets = await sealJson(this.env.SECRETS_KEY, v);
        await this.env.DB.prepare('UPDATE devices SET secrets = ?, updated_at = ? WHERE id = ?').bind(row.secrets, now(), row.id).run();
      },
      update: (fields) => this.updateDevice(row, fields),
      log: (msg) => this.sql.exec('INSERT INTO gwlog (ts, level, msg) VALUES (?,?,?)', now(), 'debug', `[${row.name}] ${msg}`),
    };
  }

  private async updateDevice(row: Row, fields: Record<string, unknown>) {
    const allowed = ['status', 'power', 'manufacturer', 'model', 'os_version', 'serial', 'firmware', 'current_app', 'mac', 'ip', 'last_seen', 'private_dns', 'privacy_score', 'dns_mode', 'monitor_until'];
    const sets: string[] = []; const vals: unknown[] = [];
    for (const k of allowed) {
      if (!(k in fields) || fields[k] === undefined) continue;
      let v = fields[k];
      if (k === 'mac') v = normMac(v as string) ?? row.mac;
      if (row[k] === v) continue;
      sets.push(`${k} = ?`); vals.push(v); row[k] = v;
    }
    if (fields.facts && typeof fields.facts === 'object') {
      const merged = { ...parseJson<Record<string, unknown>>(row.facts, {}), ...(fields.facts as object) };
      row.facts = JSON.stringify(merged);
      sets.push('facts = ?'); vals.push(row.facts);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?'); vals.push(now());
    await this.env.DB.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, row.id).run();
    const pub: Partial<Device> & { id: string } = { id: row.id };
    for (const k of allowed) if (k in fields && fields[k] !== undefined) (pub as any)[k] = row[k];
    if (fields.facts) pub.facts = parseJson(row.facts, {});
    this.broadcast({ type: 'device', device: pub });
  }

  async refreshDevice(id: string): Promise<Device> {
    const row = await this.deviceRow(id);
    const fields = await adapterFor(row.kind).refresh(this.makeCtx(row));
    if (fields.status === 'online' || fields.status === 'standby') fields.last_seen = now();
    await this.updateDevice(row, fields);
    if (row.kind === 'android' && fields.status === 'online') this.names = null;
    return toDevice(row);
  }

  async command(deviceId: string, command: string, args: Record<string, any>, actor: string): Promise<any> {
    const row = await this.deviceRow(deviceId);
    const ctx = this.makeCtx(row);
    const adapter = adapterFor(row.kind);
    const jobId = JOB_COMMANDS.has(command) ? await createJob(this.env, { site_id: this.siteId, device_id: deviceId, kind: command, params: args, actor }) : null;
    try {
      let result: any;
      if (command === 'refresh') result = await this.refreshDevice(deviceId);
      else if (command === 'pair') {
        result = await adapter.pair(ctx);
        if (result.ok) await this.refreshDevice(deviceId).catch(() => undefined);
      } else if (command === 'apps') result = await this.syncApps(row);
      else {
        if (command === 'private_dns') {
          const dot = await this.env.DB.prepare('SELECT * FROM dot_certs WHERE site_id = ?').bind(this.siteId).first<Row>();
          if (args.enabled && (!dot || dot.status !== 'issued')) throw new AdapterError('not_ready', 'DNS-over-TLS is not set up for this site yet. Enable Private DNS in the site settings first.');
          args = { ...args, hostname: dot?.hostname };
        }
        if (command === 'guest_reset') {
          const g = siteSettings(await this.site()).guest;
          args = { packages: g.clear_packages, go_home: g.go_home, reboot: g.reboot };
        }
        result = await adapter.command(ctx, command, args);
        if (['install', 'uninstall', 'disable', 'enable', 'restore'].includes(command)) this.ctx.waitUntil(this.syncApps(row).catch(() => undefined));
      }
      if (row.status === 'offline' || row.status === 'unknown') this.ctx.waitUntil(this.updateDevice(row, { status: 'online', last_seen: now() }));
      if (jobId) await finishJob(this.env, jobId, result?.ok === false ? 'error' : 'ok', result);
      if (!QUIET_COMMANDS.has(command)) await audit(this.env, actor, `device.${command}`, { target_type: 'device', target_id: deviceId, site_id: this.siteId, details: { args: redactArgs(command, args), ok: result?.ok } });
      return result;
    } catch (e: any) {
      if (jobId) await finishJob(this.env, jobId, 'error', { error: e.message, code: e.code });
      if (e.code === 'adb_unauthorized' || e.code === 'unauthorized') await this.updateDevice(row, { status: 'unauthorized' });
      if (e.code === 'pairing') await this.updateDevice(row, { status: 'pairing' });
      throw e;
    }
  }

  async syncApps(rowOrId: Row | string): Promise<any[]> {
    const row = typeof rowOrId === 'string' ? await this.deviceRow(rowOrId) : rowOrId;
    if (!['android', 'samsung', 'lg'].includes(row.kind)) return [];
    const ctx = this.makeCtx(row);
    const apps: any[] = await adapterFor(row.kind).command(ctx, 'apps', {});
    const existing = new Map((await this.env.DB.prepare('SELECT package, first_seen FROM device_apps WHERE device_id = ?').bind(row.id).all<Row>()).results.map((r) => [r.package as string, r.first_seen as number]));
    const catalog = new Map((await this.env.DB.prepare('SELECT * FROM app_catalog').all<Row>()).results.map((r) => [r.package as string, r]));
    const t = now();
    const firstSync = existing.size === 0;
    const stmts: D1PreparedStatement[] = [];
    const installed: string[] = [];
    for (const a of apps) {
      const first = existing.get(a.package) ?? t;
      if (!existing.has(a.package) && !firstSync && !a.system) installed.push(a.package);
      stmts.push(this.env.DB.prepare(`INSERT INTO device_apps (device_id, package, label, version_name, version_code, system, enabled, permissions, icon, app_id, first_seen, last_seen)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id, package) DO UPDATE SET label = excluded.label, version_name = excluded.version_name, version_code = excluded.version_code,
        system = excluded.system, enabled = excluded.enabled, permissions = excluded.permissions, icon = excluded.icon, app_id = excluded.app_id, last_seen = excluded.last_seen`)
        .bind(row.id, a.package, a.label ?? catalog.get(a.package)?.label ?? null, a.version_name ?? null, a.version_code ?? null, a.system ? 1 : 0, a.enabled ? 1 : 0, JSON.stringify(a.permissions ?? []), a.icon ?? null, a.app_id ?? null, first, t));
    }
    stmts.push(this.env.DB.prepare('DELETE FROM device_apps WHERE device_id = ? AND last_seen < ?').bind(row.id, t));
    for (const c of chunk(stmts, 50)) await this.env.DB.batch(c);
    if (row.kind === 'android') {
      const mic = await adapterFor('android').command(ctx, 'mic_usage', {}).catch(() => []);
      await this.updateDevice(row, { facts: { mic_usage: mic, apps_synced_at: t, app_count: apps.length } });
    } else {
      await this.updateDevice(row, { facts: { apps_synced_at: t, app_count: apps.length } });
    }
    for (const p of installed) {
      await raiseAlert(this.env, { severity: 'info', type: 'app.installed', title: `New app on ${row.name}: ${catalog.get(p)?.label ?? p}`, site_id: this.siteId, device_id: row.id, dedupe_key: `app:${row.id}:${p}` });
      this.ctx.waitUntil(this.fireEvent('app.installed', { device_id: row.id, package: p }));
    }
    return apps.map((a) => ({ ...a, label: a.label ?? catalog.get(a.package)?.label ?? null, category: catalog.get(a.package)?.category ?? null, risk: catalog.get(a.package)?.risk ?? null, first_seen: existing.get(a.package) ?? t, last_seen: t }));
  }

  // ---------------------------------------------------------------- discovery / adoption
  async discover(): Promise<Discovered[]> {
    const site = await this.site();
    const settings = siteSettings(site);
    const [scan, mdns, ssdp, neigh] = await Promise.allSettled([
      this.gw<any>('net.scan', { cidrs: settings.scan_cidrs.length ? settings.scan_cidrs : undefined, ports: DISCOVERY_PORTS, timeout_ms: 500 }, 90_000),
      this.gw<any>('net.mdns_browse', { services: DISCOVERY_MDNS, duration_ms: 4000 }, 20_000),
      this.gw<any>('net.ssdp_search', { st: 'ssdp:all', duration_ms: 4000 }, 20_000),
      this.gw<any>('net.neighbors', {}, 10_000),
    ]);
    const hosts = new Map<string, RawHost>();
    const get = (ip: string) => { let h = hosts.get(ip); if (!h) { h = { ip, ports: [], mdns: [], ssdp: [] }; hosts.set(ip, h); } return h; };
    if (scan.status === 'fulfilled') for (const h of scan.value.hosts ?? []) { const x = get(h.ip); x.ports = h.open_ports ?? []; x.mac = h.mac ?? x.mac; }
    if (mdns.status === 'fulfilled') for (const e of mdns.value.entries ?? []) for (const ip of (e.addrs ?? []).filter((a: string) => a.includes('.'))) get(ip).mdns.push({ service: e.service, instance: e.instance, txt: e.txt });
    if (ssdp.status === 'fulfilled') for (const e of ssdp.value.entries ?? []) get(e.ip).ssdp.push({ server: e.server, st: e.st, location: e.location, usn: e.usn });
    if (neigh.status === 'fulfilled') for (const e of neigh.value.entries ?? []) if (hosts.has(e.ip)) hosts.get(e.ip)!.mac ??= e.mac;
    if (scan.status === 'rejected' && mdns.status === 'rejected') throw scan.reason;

    const devices = (await this.env.DB.prepare('SELECT id, ip, mac FROM devices WHERE site_id = ?').bind(this.siteId).all<Row>()).results;
    const t = now();
    const results: Discovered[] = [];
    await Promise.all([...hosts.values()].map(async (h) => {
      const fp = fingerprint(h);
      if (!fp.kind) return;
      try {
        if (fp.probe === 'samsung') {
          const r = await this.gw('http.request', { url: `http://${h.ip}:8001/api/v2/`, timeout_ms: 3000 }, 6000);
          const j = JSON.parse(r.body ?? '{}');
          fp.name = j.device?.name ?? j.name ?? fp.name; fp.model = j.device?.modelName ?? fp.model;
          h.mac ??= j.device?.wifiMac;
        } else if (fp.probe === 'sonos') {
          const r = await this.gw('http.request', { url: `http://${h.ip}:1400/xml/device_description.xml`, timeout_ms: 3000 }, 6000);
          Object.assign(fp, parseSonosDescription(r.body ?? ''));
        } else if (fp.probe === 'lg-ssdp') {
          const loc = h.ssdp.find((s) => s.location)?.location;
          if (loc) {
            const r = await this.gw('http.request', { url: loc, timeout_ms: 3000 }, 6000);
            fp.name = xmlTag(r.body ?? '', 'friendlyName') ?? fp.name; fp.model = xmlTag(r.body ?? '', 'modelName') ?? fp.model;
          }
        }
      } catch { /* keep the first-pass guess */ }
      const adopted = devices.find((d) => d.ip === h.ip || (h.mac && normMac(d.mac) === normMac(h.mac)));
      const hints = { ports: h.ports, mdns: [...new Set(h.mdns.map((m) => m.service))], ssdp: [...new Set(h.ssdp.map((s) => s.server).filter(Boolean))] as string[] };
      await this.env.DB.prepare(`INSERT INTO discovered (site_id, ip, mac, kind_guess, name, model, manufacturer, hints, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(site_id, ip) DO UPDATE SET mac = COALESCE(excluded.mac, mac), kind_guess = excluded.kind_guess, name = COALESCE(excluded.name, name), model = COALESCE(excluded.model, model),
        manufacturer = COALESCE(excluded.manufacturer, manufacturer), hints = excluded.hints, last_seen = excluded.last_seen`)
        .bind(this.siteId, h.ip, normMac(h.mac), fp.kind, fp.name ?? null, fp.model ?? null, fp.manufacturer ?? null, JSON.stringify(hints), t, t).run();
      results.push({ site_id: this.siteId, ip: h.ip, mac: normMac(h.mac), kind_guess: fp.kind, name: fp.name ?? null, model: fp.model ?? null, manufacturer: fp.manufacturer ?? null, hints, first_seen: t, last_seen: t, adopted_device_id: adopted?.id ?? null });
    }));
    await audit(this.env, 'system', 'site.discover', { site_id: this.siteId, details: { found: results.length } });
    return results.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  }

  async adopt(input: { ip: string; kind: DeviceKind; name: string; room?: string; port?: number }, actor: string): Promise<Device> {
    const site = await this.site();
    const settings = siteSettings(site);
    const disc = await this.env.DB.prepare('SELECT * FROM discovered WHERE site_id = ? AND ip = ?').bind(this.siteId, input.ip).first<Row>();
    const id = rid('dev');
    const t = now();
    await this.env.DB.prepare(`INSERT INTO devices (id, site_id, kind, name, room, ip, mac, port, manufacturer, model, status, dns_mode, dns_policy, monitor_until, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, this.siteId, input.kind, input.name, input.room ?? null, input.ip, normMac(disc?.mac), input.port ?? (input.kind === 'android' ? 5555 : null),
        disc?.manufacturer ?? null, disc?.model ?? null, 'pairing', 'monitor', settings.default_policy === 'strict' ? 'strict' : 'balanced', t + settings.monitor_days * 86_400_000, t, t).run();
    await audit(this.env, actor, 'device.adopt', { target_type: 'device', target_id: id, site_id: this.siteId, details: input });
    this.names = null;
    this.ctx.waitUntil(this.pushDnsConfig().catch(() => undefined));
    if (this.online) {
      // Pairing shows an authorisation prompt on the TV and may wait ~30 s for the user; run it from the alarm.
      this.setKv('pending_pairs', [...this.kv<string[]>('pending_pairs', []), id]);
      await this.ctx.storage.setAlarm(now() + 500);
    }
    return toDevice(await this.deviceRow(id));
  }

  // ---------------------------------------------------------------- DNS queries for the dashboard
  async dnsLog(f: { device_id?: string; q?: string; action?: string; limit?: number; before?: number }): Promise<DnsLogEntry[]> {
    const where: string[] = []; const args: unknown[] = [];
    if (f.device_id) { where.push('device_id = ?'); args.push(f.device_id); }
    if (f.action) { where.push('action = ?'); args.push(f.action); }
    if (f.q) { where.push('qname LIKE ?'); args.push(`%${f.q.toLowerCase()}%`); }
    if (f.before) { where.push('ts < ?'); args.push(f.before); }
    const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 1000);
    const rows = this.sql.exec(`SELECT * FROM dnslog ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ${limit}`, ...args).toArray();
    const names = await this.deviceNames();
    return rows.map((r) => ({
      ts: r.ts as number, client: r.client as string, device_id: (r.device_id as string)?.startsWith('ip:') ? null : (r.device_id as string),
      device_name: names.get(r.device_id as string) ?? null, qname: r.qname as string, qtype: r.qtype as string, action: r.action as DnsLogEntry['action'],
      cat: (r.cat as any) ?? null, rule: r.rule as string, rcode: r.rcode as string, answers: parseJson(r.answers as string, []), ms: r.ms as number, cached: !!r.cached,
    }));
  }

  async dnsSummary(hours = 24, deviceId?: string): Promise<DnsSummary> {
    const since = now() - Math.min(hours, 24 * 14) * 3_600_000;
    const dev = deviceId ? ' AND device_id = ?' : '';
    const a = deviceId ? [since, deviceId] : [since];
    const tot = this.sql.exec(`SELECT count(*) q, sum(action = 'block') b, sum(action = 'would_block') w FROM dnslog WHERE ts >= ?${dev}`, ...a).one();
    const cats = this.sql.exec(`SELECT cat, count(*) n FROM dnslog WHERE ts >= ?${dev} AND cat IS NOT NULL GROUP BY cat`, ...a).toArray();
    const series = this.sql.exec(`SELECT (ts / 3600000) * 3600000 t, count(*) q, sum(action = 'block') b, sum(action = 'would_block') w FROM dnslog WHERE ts >= ?${dev} GROUP BY t ORDER BY t`, ...a).toArray();
    const top = this.sql.exec(`SELECT qname, max(cat) cat, count(*) q, sum(action = 'block') b, sum(action = 'would_block') w, count(DISTINCT device_id) d FROM dnslog WHERE ts >= ?${dev} GROUP BY qname ORDER BY q DESC LIMIT 15`, ...a).toArray();
    const topB = this.sql.exec(`SELECT qname, max(cat) cat, count(*) q, sum(action = 'block') b, sum(action = 'would_block') w, count(DISTINCT device_id) d FROM dnslog WHERE ts >= ?${dev} AND action != 'allow' GROUP BY qname ORDER BY q DESC LIMIT 15`, ...a).toArray();
    const byDev = deviceId ? [] : this.sql.exec(`SELECT device_id, count(*) q, sum(action = 'block') b, sum(action = 'would_block') w FROM dnslog WHERE ts >= ? GROUP BY device_id ORDER BY q DESC LIMIT 50`, since).toArray();
    const devices = new Map((await this.env.DB.prepare('SELECT id, name, kind FROM devices WHERE site_id = ?').bind(this.siteId).all<Row>()).results.map((r) => [r.id as string, r]));
    const stat = (r: any) => ({ domain: r.qname, category: r.cat ?? classify(r.qname).category, vendor: classify(r.qname).vendor, queries: r.q, blocked: r.b ?? 0, would_block: r.w ?? 0, devices: r.d });
    return {
      hours, queries: (tot.q as number) ?? 0, blocked: (tot.b as number) ?? 0, would_block: (tot.w as number) ?? 0,
      by_category: Object.fromEntries(cats.map((c) => [c.cat, c.n])),
      series: fillSeries(series.map((s) => ({ t: s.t as number, queries: s.q as number, blocked: (s.b as number) ?? 0, would_block: (s.w as number) ?? 0 })), since, hours),
      top_domains: top.map(stat), top_blocked: topB.map(stat),
      by_device: byDev.map((r) => {
        const d = devices.get(r.device_id as string);
        return { device_id: r.device_id as string, name: d?.name ?? String(r.device_id).replace(/^ip:/, 'Unknown '), kind: (d?.kind ?? 'other') as DeviceKind, queries: r.q as number, blocked: (r.b as number) ?? 0, would_block: (r.w as number) ?? 0 };
      }),
    };
  }

  async privacy(deviceId: string): Promise<DevicePrivacy> {
    const row = await this.deviceRow(deviceId);
    const summary = await this.dnsSummary(24, deviceId);
    const last = this.sql.exec('SELECT max(ts) t FROM dnslog WHERE device_id = ?', deviceId).one().t as number | null;
    const acrUnblocked = this.sql.exec("SELECT count(*) n FROM dnslog WHERE device_id = ? AND ts >= ? AND cat = 'acr' AND action != 'block'", deviceId, now() - 86_400_000).one().n as number;
    const facts = parseJson<any>(row.facts, {});
    const priv = parseJson<any>(row.privacy, {});
    const micApps = (await this.env.DB.prepare("SELECT package, label FROM device_apps WHERE device_id = ? AND permissions LIKE '%RECORD_AUDIO%'").bind(deviceId).all<Row>()).results;
    const usage = new Map<string, string | null>(((facts.mic_usage ?? []) as any[]).map((m) => [m.package, m.last_access]));
    const mic = micApps.map((m) => ({ package: m.package as string, label: m.label as string | null, last_access: usage.get(m.package as string) ?? null, granted: true }));
    const s = scoreDevice({
      kind: row.kind, dns_mode: row.dns_mode, online: row.status === 'online' || row.status === 'standby', summary, last_query_at: last,
      checklist_done: priv.checklist ?? {}, mic, private_dns: !!row.private_dns, acr_unblocked: acrUnblocked,
    });
    if (row.privacy_score !== s.score) await this.env.DB.prepare('UPDATE devices SET privacy_score = ? WHERE id = ?').bind(s.score, deviceId).run();
    return { device_id: deviceId, score: s.score, grade: s.grade, factors: s.factors, checklist: s.checklist, mic, dns: summary, bypass_suspected: s.bypass_suspected };
  }

  async mdnsStatus(): Promise<MdnsStatus | null> {
    if (this.online) {
      try { return await this.gw<MdnsStatus>('mdns.status', {}, 8000); } catch { /* fall back to last known */ }
    }
    const services = this.sql.exec('SELECT * FROM mdns_services ORDER BY service, instance').toArray().map((r) => ({
      service: r.service as string, instance: r.instance as string, iface: r.iface as string, host: r.host as string, addrs: parseJson(r.addrs as string, []), port: r.port as number, last_seen: r.last_seen as number,
    }));
    return services.length ? { enabled: false, interfaces: [], services, counters: { reflected: 0, filtered: 0, rate_limited: 0, ssdp_relayed: 0 } } : null;
  }

  async gatewayLogs(lines = 200): Promise<string[]> {
    let remote: string[] = [];
    if (this.online) remote = (await this.gw<{ lines: string[] }>('sys.logs', { lines }, 8000).catch(() => ({ lines: [] }))).lines;
    const local = this.sql.exec('SELECT ts, level, msg FROM gwlog ORDER BY ts DESC LIMIT 100').toArray()
      .map((r) => `${new Date(r.ts as number).toISOString()} ${String(r.level).toUpperCase()} ${r.msg}`).reverse();
    return remote.length ? remote : local;
  }

  async gatewayAction(action: 'restart' | 'update', actor: string) {
    if (action === 'restart') { await this.gw('sys.restart', {}, 5000).catch(() => undefined); }
    else {
      const rel = await this.env.DB.prepare('SELECT * FROM agent_releases ORDER BY created_at DESC LIMIT 1').first<Row>();
      if (!rel) throw new HttpError(404, 'no_release', 'No gateway release has been published yet');
      const gwRow = await this.env.DB.prepare("SELECT arch FROM gateways WHERE site_id = ? AND status != 'revoked' ORDER BY created_at DESC LIMIT 1").bind(this.siteId).first<Row>();
      const arm = gwRow?.arch === 'arm64';
      const key = arm ? rel.arm64_key : rel.amd64_key;
      const sha = arm ? rel.arm64_sha256 : rel.amd64_sha256;
      if (!key) throw new HttpError(404, 'no_release', `No ${arm ? 'arm64' : 'amd64'} build in release ${rel.version}`);
      const url = await signAgentUrl(this.env.SIGNING_SECRET, this.origin, 'GET', key, 30 * 60_000);
      await this.gw('sys.update', { version: rel.version, url, sha256: sha }, 300_000);
    }
    await audit(this.env, actor, `gateway.${action}`, { site_id: this.siteId });
  }

  async disconnectAgent(reason = 'revoked') {
    for (const ws of this.ctx.getWebSockets('agent')) { try { ws.close(4003, reason); } catch { /* */ } }
  }

  // ---------------------------------------------------------------- guest / apps policy
  async guestReset(deviceIds: string[] | undefined, actor: string) {
    const devices = (await this.env.DB.prepare("SELECT id, kind, name FROM devices WHERE site_id = ? AND kind IN ('android','samsung')").bind(this.siteId).all<Row>()).results
      .filter((d) => !deviceIds?.length || deviceIds.includes(d.id));
    const results = await Promise.all(devices.map(async (d) => {
      try {
        const r = await this.command(d.id, 'guest_reset', {}, actor);
        return { device_id: d.id, name: d.name, ok: r?.ok !== false, detail: r?.detail ?? (r?.cleared ? `Cleared ${r.cleared.length} app(s)` : 'Done') };
      } catch (e: any) {
        return { device_id: d.id, name: d.name, ok: false, detail: e.message };
      }
    }));
    await audit(this.env, actor, 'site.guest_reset', { site_id: this.siteId, details: { devices: results.length, failed: results.filter((r) => !r.ok).length } });
    return { results };
  }

  async enforceApps(deviceIds: string[] | undefined, actor: string) {
    const site = await this.site();
    const policies = (await this.env.DB.prepare('SELECT * FROM app_policies WHERE enabled = 1').all<Row>()).results;
    const devices = (await this.env.DB.prepare("SELECT * FROM devices WHERE site_id = ? AND kind = 'android' AND status = 'online'").bind(this.siteId).all<Row>()).results
      .filter((d) => !deviceIds?.length || deviceIds.includes(d.id));
    const report: any[] = [];
    for (const d of devices) {
      const applicable = policies.filter((p) => p.scope_type === 'global' || (p.scope_type === 'client' && p.scope_id === site.client_id) || (p.scope_type === 'site' && p.scope_id === this.siteId) || (p.scope_type === 'device' && p.scope_id === d.id));
      if (!applicable.length) continue;
      const apps = (await this.env.DB.prepare('SELECT package, system, enabled FROM device_apps WHERE device_id = ?').bind(d.id).all<Row>()).results;
      const have = new Map(apps.map((a) => [a.package as string, a]));
      const actions: { action: string; package: string; ok: boolean; detail?: string }[] = [];
      const run = async (command: string, args: Record<string, unknown>, pkg: string) => {
        try { const r = await this.command(d.id, command, args, actor); actions.push({ action: command, package: pkg, ok: r?.ok !== false }); }
        catch (e: any) { actions.push({ action: command, package: pkg, ok: false, detail: e.message }); }
      };
      for (const p of applicable) {
        for (const req of parseJson<{ package: string; apk_id?: string }[]>(p.required, [])) {
          if (!have.has(req.package) && req.apk_id) await run('install', { apk_id: req.apk_id }, req.package);
          else if (have.get(req.package)?.enabled === 0) await run('enable', { package: req.package }, req.package);
        }
        for (const pkg of parseJson<string[]>(p.banned, [])) {
          const a = have.get(pkg);
          if (!a) continue;
          if (p.ban_action === 'uninstall') await run('uninstall', { package: pkg }, pkg);
          else if (a.enabled) await run('disable', { package: pkg }, pkg);
        }
        const kiosk = parseJson<string[] | null>(p.kiosk_allowed, null);
        if (kiosk?.length) {
          for (const a of apps) if (!a.system && a.enabled && !kiosk.includes(a.package as string)) await run('disable', { package: a.package }, a.package as string);
        }
      }
      report.push({ device_id: d.id, name: d.name, actions });
    }
    return { devices: report };
  }

  // ---------------------------------------------------------------- automations
  async runAutomation(automationId: string, ctxDeviceId: string | null = null): Promise<{ ok: boolean; job_id: string }> {
    const row = await this.env.DB.prepare('SELECT * FROM automations WHERE id = ?').bind(automationId).first<Row>();
    if (!row) throw new HttpError(404, 'not_found', 'Automation not found');
    const a = toAutomation(row);
    const t = a.target;
    let devices = (await this.env.DB.prepare('SELECT id, kind, tags FROM devices WHERE site_id = ?').bind(this.siteId).all<Row>()).results;
    devices = devices.filter((d) => (!t.kinds?.length || t.kinds.includes(d.kind)) && (!t.device_ids?.length || t.device_ids.includes(d.id))
      && (!t.tags?.length || parseJson<string[]>(d.tags, []).some((tag) => t.tags!.includes(tag))));
    if (ctxDeviceId) devices = devices.filter((d) => d.id === ctxDeviceId);
    const ids = devices.map((d) => d.id as string);
    const jobId = await createJob(this.env, { site_id: this.siteId, kind: 'automation', params: { automation: a.name, devices: ids.length }, actor: `automation:${a.name}`, automation_id: a.id });
    const results = await this.runActions(a, ids);
    const ok = results.every((r) => r.ok);
    await finishJob(this.env, jobId, ok ? 'ok' : 'error', results);
    await this.env.DB.prepare('UPDATE automations SET last_run = ?, last_status = ? WHERE id = ?').bind(now(), ok ? 'ok' : 'error', a.id).run();
    return { ok, job_id: jobId };
  }

  private async runActions(a: Automation, deviceIds: string[]) {
    const actor = `automation:${a.name}`;
    const results: { action: string; ok: boolean; detail?: unknown }[] = [];
    for (const act of a.actions as AutomationAction[]) {
      try {
        switch (act.type) {
          case 'delay': await sleep(Math.min(300, Math.max(0, act.seconds)) * 1000); results.push({ action: 'delay', ok: true }); break;
          case 'alert': await raiseAlert(this.env, { severity: act.severity, type: 'automation', title: act.title, site_id: this.siteId, details: `From automation "${a.name}"` }); results.push({ action: 'alert', ok: true }); break;
          case 'guest_reset': { const r = await this.guestReset(deviceIds, actor); results.push({ action: 'guest_reset', ok: r.results.every((x) => x.ok), detail: r.results }); break; }
          case 'enforce_apps': { const r = await this.enforceApps(deviceIds, actor); results.push({ action: 'enforce_apps', ok: true, detail: r.devices }); break; }
          case 'dns_mode': {
            for (const id of deviceIds) await this.env.DB.prepare('UPDATE devices SET dns_mode = ?, monitor_until = NULL, updated_at = ? WHERE id = ?').bind(act.mode, now(), id).run();
            await this.pushDnsConfig().catch(() => undefined);
            results.push({ action: 'dns_mode', ok: true });
            break;
          }
          case 'command': {
            const per = await Promise.all(deviceIds.map(async (id) => {
              try { const r = await this.command(id, act.command, act.args ?? {}, actor); return { device_id: id, ok: r?.ok !== false }; }
              catch (e: any) { return { device_id: id, ok: false, error: e.message }; }
            }));
            results.push({ action: `command:${act.command}`, ok: per.every((p) => p.ok), detail: per });
            break;
          }
        }
      } catch (e: any) {
        results.push({ action: act.type, ok: false, detail: e.message });
      }
    }
    return results;
  }

  private async fireEvent(event: AutomationEvent, ctx: { device_id?: string; package?: string }) {
    const site = await this.site().catch(() => null);
    if (!site) return;
    const rows = (await this.env.DB.prepare("SELECT * FROM automations WHERE enabled = 1 AND json_extract(trigger, '$.type') = 'event' AND json_extract(trigger, '$.event') = ?").bind(event).all<Row>()).results;
    for (const r of rows) {
      const inScope = r.scope_type === 'global' || (r.scope_type === 'client' && r.scope_id === site.client_id) || (r.scope_type === 'site' && r.scope_id === this.siteId);
      const target = parseJson<any>(r.target, {});
      if (!inScope || (target.site_ids?.length && !target.site_ids.includes(this.siteId))) continue;
      await this.runAutomation(r.id, ctx.device_id ?? null).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- periodic work
  private async scheduleTick(inMs = TICK_MS) {
    const cur = await this.ctx.storage.getAlarm();
    const at = now() + inMs;
    if (!cur || cur > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const t = now();
    let siteOk = true;
    try { await this.site(); } catch { siteOk = false; }
    if (!siteOk) return; // site deleted: stop ticking
    const due = (k: string, every: number) => { const last = this.kv<number>(`last_${k}`, 0); if (t - last >= every) { this.setKv(`last_${k}`, t); return true; } return false; };
    try {
      const pairs = this.kv<string[]>('pending_pairs', []);
      if (pairs.length && this.online) {
        this.setKv('pending_pairs', []);
        await Promise.all(pairs.map(async (id) => {
          const row = await this.deviceRow(id).catch(() => null);
          if (!row) return;
          const res = await adapterFor(row.kind).pair(this.makeCtx(row)).catch((e: any) => ({ ok: false, detail: e.message }));
          if (res.ok) await this.refreshDevice(id).catch(() => undefined);
          else await this.updateDevice(row, { status: 'pairing', facts: { pairing_detail: res.detail } });
        }));
      }
      if (this.online) {
        await this.probeDevices();
        if (due('refresh', 5 * 60_000)) await this.refreshAll();
        if (due('inventory', 6 * 3_600_000)) await this.inventoryAll();
      } else {
        const since = this.kv<number | null>('offline_since', null);
        if (since && t - since > 3 * 60_000) {
          const site = await this.site();
          await raiseAlert(this.env, { severity: 'critical', type: 'gateway.offline', title: `Gateway offline at ${site.name}`, details: 'The site gateway has not been connected for over 3 minutes. DNS filtering keeps running locally on the last settings.', site_id: this.siteId, dedupe_key: `gw_offline:${this.siteId}` });
          if (!this.kv<boolean>('offline_event_fired', false)) { this.setKv('offline_event_fired', true); await this.fireEvent('gateway.offline', {}); }
        }
      }
      if (this.online) this.setKv('offline_event_fired', false);
      if (this.kv<boolean>('dot_pending', false) && this.online) await this.provisionDot();
      if (due('flush', 5 * 60_000)) await this.flushAggregates();
      if (due('hourly', 3_600_000)) await this.hourly();
    } finally {
      await this.ctx.storage.setAlarm(now() + (this.online ? TICK_MS : 5 * 60_000));
    }
  }

  private async probeDevices() {
    const devices = (await this.env.DB.prepare("SELECT * FROM devices WHERE site_id = ? AND ip IS NOT NULL AND ip != ''").bind(this.siteId).all<Row>()).results;
    if (!devices.length) return;
    const res = await this.gw<{ results: { id: string; ok: boolean; status?: number; body?: string }[] }>('net.probe', {
      targets: devices.map((d) => ({ id: d.id, ...probeTarget(d.kind, d.ip, d.port), timeout_ms: 1500 })),
    }, 20_000).catch(() => null);
    if (!res) return;
    const byId = new Map(res.results.map((r) => [r.id, r]));
    for (const d of devices) {
      const r = byId.get(d.id);
      if (!r) continue;
      if (r.ok) {
        this.sql.exec('DELETE FROM probe_fails WHERE device_id = ?', d.id);
        let status = d.status === 'offline' || d.status === 'unknown' ? 'online' : d.status;
        let power = d.power;
        if (d.kind === 'samsung' && r.body) {
          const ps = parseJson<any>(r.body, {}).device?.PowerState;
          power = ps === 'standby' ? 'standby' : 'on';
          status = power === 'standby' ? 'standby' : 'online';
        }
        if (status !== d.status || power !== d.power || now() - (d.last_seen ?? 0) > 5 * 60_000) await this.updateDevice(d, { status, power, last_seen: now() });
        if (d.status === 'offline') {
          await resolveAlert(this.env, `dev_offline:${d.id}`);
          this.ctx.waitUntil(this.fireEvent('device.online', { device_id: d.id }));
        }
      } else {
        const n = ((this.sql.exec('SELECT n FROM probe_fails WHERE device_id = ?', d.id).toArray()[0]?.n as number) ?? 0) + 1;
        this.sql.exec('INSERT INTO probe_fails (device_id, n) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET n = excluded.n', d.id, n);
        if (n === OFFLINE_AFTER_FAILS && d.status !== 'offline') {
          await this.updateDevice(d, { status: 'offline', power: d.kind === 'sonos' ? d.power : 'off' });
          await raiseAlert(this.env, { severity: 'warning', type: 'device.offline', title: `${d.name} is offline`, site_id: this.siteId, device_id: d.id, dedupe_key: `dev_offline:${d.id}` });
          this.ctx.waitUntil(this.fireEvent('device.offline', { device_id: d.id }));
        }
      }
    }
  }

  private async refreshAll() {
    const devices = (await this.env.DB.prepare("SELECT id FROM devices WHERE site_id = ? AND status IN ('online','standby','unauthorized','pairing') AND kind IN ('android','samsung','sonos','lg')").bind(this.siteId).all<Row>()).results;
    await Promise.all(devices.map((d) => this.refreshDevice(d.id).catch(() => undefined)));
  }

  private async inventoryAll() {
    const devices = (await this.env.DB.prepare("SELECT id FROM devices WHERE site_id = ? AND status = 'online' AND kind IN ('android','samsung','lg')").bind(this.siteId).all<Row>()).results;
    for (const d of devices) await this.syncApps(d.id).catch(() => undefined);
    await this.enforceApps(undefined, 'policy').catch(() => undefined);
  }

  /** Push DO-local DNS aggregates to D1 (fleet dashboards read D1). */
  async flushAggregates() {
    const settings = await getAppSettings(this.env);
    for (let round = 0; round < 10; round++) {
      const daily = this.sql.exec('SELECT * FROM agg_daily WHERE dirty = 1 LIMIT 200').toArray();
      if (!daily.length) break;
      const stmts: D1PreparedStatement[] = [];
      for (const r of daily) {
        const cls = classify(r.domain as string);
        stmts.push(this.env.DB.prepare(`INSERT INTO dns_daily (day, site_id, device_id, domain, category, queries, blocked, would_block) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(day, device_id, domain) DO UPDATE SET queries = excluded.queries, blocked = excluded.blocked, would_block = excluded.would_block, category = COALESCE(excluded.category, category)`)
          .bind(r.day, this.siteId, r.device_id, r.domain, r.cat ?? cls.category, r.q, r.b, r.w));
        const dq = (r.q as number) - (r.fq as number), db = (r.b as number) - (r.fb as number), dw = (r.w as number) - (r.fw as number);
        if (dq > 0) {
          stmts.push(this.env.DB.prepare(`INSERT INTO domains (domain, category, vendor, first_seen, last_seen, queries, blocked, would_block) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(domain) DO UPDATE SET last_seen = excluded.last_seen, queries = queries + excluded.queries, blocked = blocked + excluded.blocked, would_block = would_block + excluded.would_block, category = COALESCE(excluded.category, category), vendor = COALESCE(excluded.vendor, vendor)`)
            .bind(r.domain, r.cat ?? cls.category, cls.vendor, now(), now(), dq, db, dw));
        }
      }
      for (const c of chunk(stmts, 80)) await this.env.DB.batch(c);
      for (const r of daily) {
        // Record what was sent (so domain deltas never double count), and only clear dirty if nothing arrived meanwhile.
        this.sql.exec('UPDATE agg_daily SET fq = ?, fb = ?, fw = ? WHERE day = ? AND device_id = ? AND domain = ?', r.q, r.b, r.w, r.day, r.device_id, r.domain);
        this.sql.exec('UPDATE agg_daily SET dirty = 0 WHERE day = ? AND device_id = ? AND domain = ? AND q = ?', r.day, r.device_id, r.domain, r.q);
      }
    }
    const hourly = this.sql.exec('SELECT * FROM agg_hourly WHERE dirty = 1 LIMIT 500').toArray();
    const hs = hourly.map((r) => this.env.DB.prepare(`INSERT INTO dns_hourly (hour, site_id, device_id, queries, blocked, would_block, cats) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(hour, device_id) DO UPDATE SET queries = excluded.queries, blocked = excluded.blocked, would_block = excluded.would_block, cats = excluded.cats`)
      .bind(r.hour, this.siteId, r.device_id, r.q, r.b, r.w, r.cats ?? '{}'));
    for (const c of chunk(hs, 80)) await this.env.DB.batch(c);
    for (const r of hourly) this.sql.exec('UPDATE agg_hourly SET dirty = 0 WHERE hour = ? AND device_id = ? AND q = ?', r.hour, r.device_id, r.q);
    // Retention
    const keep = Math.max(1, settings.dns_log_retention_days) * 86_400_000;
    this.sql.exec('DELETE FROM dnslog WHERE ts < ?', now() - keep);
    this.sql.exec('DELETE FROM agg_daily WHERE dirty = 0 AND day < ?', dayKey(now() - 3 * 86_400_000));
    this.sql.exec('DELETE FROM agg_hourly WHERE dirty = 0 AND hour < ?', now() - 3 * 86_400_000);
    this.sql.exec('DELETE FROM gwlog WHERE rowid NOT IN (SELECT rowid FROM gwlog ORDER BY ts DESC LIMIT 500)');
  }

  private async hourly() {
    const t = now();
    const site = await this.site();
    const devices = (await this.env.DB.prepare('SELECT * FROM devices WHERE site_id = ?').bind(this.siteId).all<Row>()).results;
    let pushed = false;
    for (const d of devices) {
      // Monitoring period finished → start enforcing.
      if (d.dns_mode === 'monitor' && d.monitor_until && d.monitor_until <= t) {
        await this.env.DB.prepare("UPDATE devices SET dns_mode = 'enforce', monitor_until = NULL, updated_at = ? WHERE id = ?").bind(t, d.id).run();
        await raiseAlert(this.env, { severity: 'info', type: 'dns.enforcing', title: `${d.name} is now blocking trackers (${d.dns_policy})`, details: 'The monitoring period ended, so Screens switched this device from Monitor to Enforce.', site_id: this.siteId, device_id: d.id, dedupe_key: `enforce:${d.id}` });
        pushed = true;
      }
      // DNS bypass detection.
      if (d.kind !== 'sonos' && (d.status === 'online') && d.dns_mode !== 'bypass') {
        const last = this.sql.exec('SELECT max(ts) t FROM dnslog WHERE device_id = ?', d.id).one().t as number | null;
        const since = Math.max(d.created_at as number, last ?? 0);
        if (t - since > 2 * 3_600_000) {
          await raiseAlert(this.env, { severity: 'warning', type: 'dns.bypass', title: `${d.name} isn't using the Screens DNS filter`, details: last ? 'No lookups seen for over 2 hours while the device is online. It may be using hard-coded DNS.' : `No lookups have been seen yet. Set the device's DNS to the gateway at ${site.name}.`, site_id: this.siteId, device_id: d.id, dedupe_key: `dns_bypass:${d.id}` });
          if (!this.kv<boolean>(`bypass_evt:${d.id}`, false)) { this.setKv(`bypass_evt:${d.id}`, true); await this.fireEvent('dns.bypass_suspected', { device_id: d.id }); }
        } else {
          await resolveAlert(this.env, `dns_bypass:${d.id}`);
          this.setKv(`bypass_evt:${d.id}`, false);
        }
      }
      if (d.kind !== 'other') await this.privacy(d.id).catch(() => undefined);
    }
    if (pushed) await this.pushDnsConfig().catch(() => undefined);
    // Renew DoT certificates 30 days before expiry.
    const dot = await this.env.DB.prepare("SELECT * FROM dot_certs WHERE site_id = ? AND status = 'issued'").bind(this.siteId).first<Row>();
    if (dot?.not_after && dot.not_after - t < 30 * 86_400_000 && siteSettings(site).dot_enabled) this.setKv('dot_pending', true);
  }

  // ---------------------------------------------------------------- RPC entry point
  /**
   * Single RPC entry for the Worker. Errors are returned as data because custom error
   * properties (status, code) don't survive Durable Object RPC serialisation.
   */
  async rpc(siteId: string, origin: string | null, method: string, args: unknown[]): Promise<{ ok: true; data: unknown } | { ok: false; status: number; code: string; message: string }> {
    this.remember(siteId, origin);
    const allowed: Record<string, (...a: any[]) => Promise<unknown>> = {
      command: this.command, refreshDevice: this.refreshDevice, syncApps: this.syncApps, discover: this.discover, adopt: this.adopt,
      dnsLog: this.dnsLog, dnsSummary: this.dnsSummary, privacy: this.privacy, mdnsStatus: this.mdnsStatus, gatewayLogs: this.gatewayLogs,
      gatewayAction: this.gatewayAction, disconnectAgent: this.disconnectAgent, guestReset: this.guestReset, enforceApps: this.enforceApps,
      runAutomation: this.runAutomation, pushDnsConfig: this.pushDnsConfig, pushMdnsConfig: this.pushMdnsConfig, status: this.status,
      requestDot: this.requestDot, flushAggregates: this.flushAggregates,
    };
    const fn = allowed[method];
    if (!fn) return { ok: false, status: 400, code: 'bad_method', message: `Unknown hub method ${method}` };
    try {
      return { ok: true, data: await fn.apply(this, args) };
    } catch (e: any) {
      const code = e?.code ?? 'error';
      const status = e instanceof HttpError ? e.status : statusForCode(code);
      return { ok: false, status, code, message: e?.message ?? String(e) };
    }
  }

  // ---------------------------------------------------------------- DNS-over-TLS (Android Private DNS)
  async requestDot() {
    this.setKv('dot_pending', true);
    await this.env.DB.prepare(`INSERT INTO dot_certs (site_id, hostname, status, updated_at) VALUES (?, ?, 'pending', ?)
      ON CONFLICT(site_id) DO UPDATE SET status = 'pending', last_error = NULL, updated_at = excluded.updated_at`).bind(this.siteId, await this.dotHostname(), now()).run();
    await this.ctx.storage.setAlarm(now() + 1000);
    return { ok: true };
  }

  private async dotHostname(): Promise<string> {
    const site = await this.site();
    const app = await getAppSettings(this.env);
    const base = (app.dot_base_domain || this.env.DOT_BASE_DOMAIN || '').replace(/^\.+|\.+$/g, '');
    if (!base) throw new HttpError(409, 'not_configured', 'Set the DNS-over-TLS base domain in Settings first');
    return `${site.slug}.${base}`;
  }

  /** Pick the gateway address on the subnet where most Android devices live. */
  private async dotAddress(): Promise<string> {
    const gwRow = await this.env.DB.prepare("SELECT info FROM gateways WHERE site_id = ? AND status = 'online' ORDER BY connected_at DESC LIMIT 1").bind(this.siteId).first<Row>();
    const ifaces = (parseJson<any>(gwRow?.info, {}).interfaces ?? []) as { addrs: string[] }[];
    const cidrs = ifaces.flatMap((i) => i.addrs).filter((a) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(a) && !a.startsWith('127.') && !a.startsWith('172.17.'));
    if (!cidrs.length) throw new AdapterError('not_ready', 'Gateway has no usable IPv4 address');
    const devices = (await this.env.DB.prepare("SELECT ip FROM devices WHERE site_id = ? AND kind = 'android' AND ip IS NOT NULL").bind(this.siteId).all<Row>()).results;
    const toInt = (ip: string) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
    let best = cidrs[0], bestN = -1;
    for (const c of cidrs) {
      const [ip, bits] = c.split('/');
      const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
      const n = devices.filter((d) => ((toInt(d.ip) & mask) >>> 0) === ((toInt(ip) & mask) >>> 0)).length;
      if (n > bestN) { best = c; bestN = n; }
    }
    return best.split('/')[0];
  }

  private async provisionDot() {
    this.setKv('dot_pending', false);
    const host = await this.dotHostname();
    const logLines: string[] = [];
    const log = (m: string) => { logLines.push(m); this.sql.exec('INSERT INTO gwlog (ts, level, msg) VALUES (?,?,?)', now(), 'info', `[dot] ${m}`); };
    try {
      if (!this.online) throw new Error('Gateway is offline');
      const ip = await this.dotAddress();
      const zone = await zoneId(this.env, host);
      log(`Pointing ${host} at ${ip}`);
      const recordId = await upsertRecord(this.env, zone, 'A', host, ip);
      const { csr_pem } = await this.gw<{ csr_pem: string }>('tls.csr', { hostname: host }, 20_000);
      const chain = await issueCertificate(this.env, host, csr_pem, log);
      await this.gw('tls.install', { cert_pem: chain }, 20_000);
      const notAfter = certNotAfter(chain);
      await this.env.DB.prepare("UPDATE dot_certs SET hostname = ?, status = 'issued', not_after = ?, last_error = NULL, dns_record_id = ?, updated_at = ? WHERE site_id = ?")
        .bind(host, notAfter, recordId, now(), this.siteId).run();
      log(`Certificate installed (valid until ${notAfter ? new Date(notAfter).toISOString() : 'unknown'})`);
      await this.pushDnsConfig();
    } catch (e: any) {
      log(`Failed: ${e.message}`);
      await this.env.DB.prepare("UPDATE dot_certs SET status = 'error', last_error = ?, updated_at = ? WHERE site_id = ?").bind(String(e.message).slice(0, 500), now(), this.siteId).run();
    }
  }

  async status() {
    return { online: this.online, metrics: this.kv('metrics', null), offline_since: this.kv('offline_since', null) };
  }
}

function fillSeries(points: { t: number; queries: number; blocked: number; would_block: number }[], since: number, hours: number) {
  const byT = new Map(points.map((p) => [p.t, p]));
  const out = [];
  const start = Math.floor(since / 3_600_000) * 3_600_000;
  for (let i = 0; i <= hours; i++) {
    const t = start + i * 3_600_000;
    out.push(byT.get(t) ?? { t, queries: 0, blocked: 0, would_block: 0 });
  }
  return out;
}

function redactArgs(command: string, args: Record<string, unknown>) {
  if (command === 'text') return { text: '[redacted]' };
  return args;
}

export function statusForCode(code: string): number {
  const m: Record<string, number> = {
    bad_args: 400, bad_package: 400, bad_device: 400, not_supported: 400, not_found: 404, forbidden: 403,
    gateway_offline: 503, timeout: 504, unreachable: 502, failed: 502, closed: 502,
    pairing: 409, unauthorized: 409, adb_unauthorized: 409, adb_offline: 409, not_ready: 409, not_configured: 409,
  };
  return m[code] ?? 500;
}
