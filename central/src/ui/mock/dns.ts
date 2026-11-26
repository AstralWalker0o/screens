// Synthetic but realistic DNS traffic: per device, per hour, per category,
// spread over real-looking vendor domains. Drives summaries, logs and the live feed.

import type { Device, DeviceKind, DnsCategory, DnsDomainStat, DnsLogEntry, DnsRule, DnsSummary } from '../../shared/types';
import { D, H, NOW, S } from './data';
import { between, mulberry32, pick, pickWeighted } from './rand';

type W = readonly (readonly [string, number])[];

const STREAM_TV: W = [['api-global.netflix.com', 3], ['ipv4-c001-syd001-ix.1.oca.nflxvideo.net', 4], ['youtubei.googleapis.com', 3], ['rr4---sn-ntqe6n76.googlevideo.com', 4], ['stan-dash.akamaized.net', 2], ['api.stan.com.au', 1], ['disney.api.edge.bamgrid.com', 1]];

export const DOMAINS: Record<DeviceKind, Partial<Record<DnsCategory, W>>> = {
  samsung: {
    acr: [['log-ingestion.samsungacr.com', 4], ['log-config.samsungacr.com', 3], ['acr0.samsungcloudsolution.com', 2], ['acr-eu-prd.samsungcloud.tv', 1]],
    ads: [['config.samsungads.com', 3], ['samsungads.com', 3], ['ads.samsungads.com', 2], ['us.info.samsungads.com', 1]],
    telemetry: [['osb.samsungqbe.com', 3], ['gpm.samsungqbe.com', 2], ['lcprd1.samsungcloudsolution.net', 2], ['upu.samsungelectronics.com', 1]],
    tracking: [['samsung-com.112.2o7.net', 2], ['sb.scorecardresearch.com', 2], ['ssl.google-analytics.com', 1]],
    vendor: [['api.samsungcloudsolution.com', 3], ['cdn.samsungcloudsolution.com', 2], ['us-auth2.samsungosp.com', 1], ['api.amazonalexa.com', 1]],
    update: [['samsungotn.net', 2], ['otnprd9.samsungcloudsolution.net', 1]],
    streaming: STREAM_TV,
    essential: [['time.samsungcloudsolution.com', 3], ['pool.ntp.org', 1]],
    unknown: [['d1oxlq5h9kq8q5.cloudfront.net', 1], ['tvx-cdn.akamaized.net', 1]],
  },
  lg: {
    acr: [['tkacr316.alphonso.tv', 3], ['alphonso.tv', 2], ['aic-ngfts.lge.com', 2]],
    ads: [['ad.lgappstv.com', 2], ['lgad.cjpowercast.com', 2], ['ngfts.lge.com', 2], ['us.ad.lgsmartad.com', 2]],
    telemetry: [['lgtvsdp.com', 3], ['eic.lgtvsdp.com', 2], ['us.info.lgsmartad.com', 1]],
    tracking: [['sb.scorecardresearch.com', 1], ['ssl.google-analytics.com', 1]],
    vendor: [['us.lgeapi.com', 2], ['aic-common.lgthinq.com', 1], ['lgappstv.com', 1]],
    update: [['snu.lge.com', 2]],
    streaming: STREAM_TV,
    essential: [['time.lge.com', 2]],
    unknown: [['d3q1u2y8z1v1nw.cloudfront.net', 1]],
  },
  android: {
    acr: [['api.samba.tv', 1]],
    ads: [['googleads.g.doubleclick.net', 3], ['pagead2.googlesyndication.com', 2], ['www.googleadservices.com', 2], ['imasdk.googleapis.com', 2], ['aax-us-east.amazon-adsystem.com', 1]],
    telemetry: [['app-measurement.com', 3], ['firebaselogging-pa.googleapis.com', 3], ['telemetry.gfe.nvidia.com', 2], ['events.gfe.nvidia.com', 2], ['device-metrics-us.amazon.com', 1], ['ichnaea.netflix.com', 1], ['firebase-settings.crashlytics.com', 1]],
    tracking: [['in.appcenter.ms', 1], ['api.mixpanel.com', 1], ['graph.facebook.com', 1], ['sb.scorecardresearch.com', 1], ['data.flurry.com', 1]],
    vendor: [['api.amazonalexa.com', 1], ['clients4.google.com', 2], ['play.googleapis.com', 2], ['accounts.nvgs.nvidia.com', 1]],
    update: [['ota.nvidia.com', 2], ['dl.google.com', 1]],
    streaming: [['api-global.netflix.com', 2], ['ipv4-c001-syd001-ix.1.oca.nflxvideo.net', 4], ['youtubei.googleapis.com', 2], ['rr4---sn-ntqe6n76.googlevideo.com', 4], ['plex.tv', 1], ['clients.plex.tv', 1], ['api.stan.com.au', 1], ['disney.api.edge.bamgrid.com', 1], ['audio4-ak-spotify-com.akamaized.net', 1], ['spclient.wg.spotify.com', 1]],
    essential: [['connectivitycheck.gstatic.com', 3], ['time.android.com', 2], ['android.clients.google.com', 2], ['mtalk.google.com', 2], ['www.google.com', 1]],
    unknown: [['r3.o.lencr.org', 1], ['d2ef20sk9hi1u3.cloudfront.net', 1]],
  },
  sonos: {
    telemetry: [['msmetrics.ws.sonos.com', 3], ['sonos-collector.ws.sonos.com', 1]],
    vendor: [['api.ws.sonos.com', 2], ['conn-ap.ws.sonos.com', 1], ['api.amazonalexa.com', 1]],
    update: [['update.sonos.com', 1]],
    streaming: [['spclient.wg.spotify.com', 2], ['audio4-ak-spotify-com.akamaized.net', 3], ['api.spotify.com', 1], ['opml.radiotime.com', 1]],
    essential: [['pool.ntp.org', 1], ['www.sonos.com', 1]],
  },
  other: {
    essential: [['pool.ntp.org', 1]],
    unknown: [['iot.example-cloud.com', 1]],
  },
};

const GUEST_DOMAINS: Partial<Record<DnsCategory, W>> = {
  streaming: [['i.instagram.com', 2], ['scontent.cdninstagram.com', 2], ['www.tiktok.com', 1], ['v16-webapp.tiktok.com', 1]],
  essential: [['captive.apple.com', 2], ['gateway.icloud.com', 2], ['www.google.com', 1], ['time.apple.com', 1]],
  tracking: [['graph.facebook.com', 2], ['app-measurement.com', 1], ['api.branch.io', 1]],
  ads: [['googleads.g.doubleclick.net', 1], ['ads.tiktok.com', 1]],
  telemetry: [['firebaselogging-pa.googleapis.com', 1], ['metrics.icloud.com', 1]],
};

const CAT_WEIGHTS: Record<DeviceKind, readonly (readonly [DnsCategory, number])[]> = {
  samsung: [['acr', 20], ['ads', 10], ['telemetry', 10], ['tracking', 4], ['vendor', 12], ['update', 2], ['streaming', 30], ['essential', 10], ['unknown', 2]],
  lg: [['acr', 18], ['ads', 14], ['telemetry', 10], ['tracking', 4], ['vendor', 12], ['update', 2], ['streaming', 28], ['essential', 10], ['unknown', 2]],
  android: [['acr', 0.4], ['ads', 8], ['telemetry', 11], ['tracking', 6], ['vendor', 6], ['update', 1], ['streaming', 50], ['essential', 15], ['unknown', 2.5]],
  sonos: [['telemetry', 14], ['vendor', 14], ['update', 2], ['streaming', 58], ['essential', 12]],
  other: [['essential', 50], ['unknown', 50]],
};
const GUEST_CATS: readonly (readonly [DnsCategory, number])[] = [['streaming', 40], ['essential', 30], ['tracking', 14], ['ads', 8], ['telemetry', 8]];

const BLOCKED_BY: Record<string, DnsCategory[]> = {
  balanced: ['acr', 'ads', 'telemetry', 'tracking', 'malware'],
  strict: ['acr', 'ads', 'telemetry', 'tracking', 'malware', 'vendor'],
  monitor: [],
};

// Hour-of-day (Sydney) activity curve: quiet overnight, peak in the evening.
const DIURNAL = [0.35, 0.25, 0.2, 0.18, 0.18, 0.22, 0.35, 0.55, 0.7, 0.65, 0.6, 0.6, 0.65, 0.65, 0.6, 0.65, 0.8, 1.0, 1.3, 1.5, 1.55, 1.4, 1.0, 0.6];
const BASE_RATE: Record<DeviceKind, number> = { samsung: 260, lg: 120, android: 420, sonos: 70, other: 10 };

const sydHour = (t: number) => new Date(t).getUTCHours() + 11 - (new Date(t).getUTCHours() + 11 >= 24 ? 24 : 0);

function activity(d: Device, t: number): number {
  if (d.status === 'offline' && d.last_seen && t > d.last_seen) return 0;
  let f = DIURNAL[sydHour(t)] ?? 1;
  if (d.power === 'standby' || d.status === 'standby') f *= 0.35;
  if (d.status === 'pairing') f *= 0.7;
  return f;
}

export function actionFor(d: Pick<Device, 'dns_mode' | 'dns_policy' | 'dns_allow' | 'dns_block'> | null, cat: DnsCategory, domain: string, unknownMode: string, rules: DnsRule[]): DnsLogEntry['action'] {
  const mode = d?.dns_mode ?? unknownMode;
  const policy = d?.dns_policy ?? 'balanced';
  if (mode === 'off' || mode === 'bypass') return 'allow';
  if (d?.dns_allow.some((a) => domain === a || domain.endsWith(`.${a}`))) return 'allow';
  const allowRule = rules.find((r) => r.action === 'allow' && (domain === r.domain || domain.endsWith(`.${r.domain}`)));
  if (allowRule) return 'allow';
  const blockRule = rules.find((r) => r.action === 'block' && (domain === r.domain || domain.endsWith(`.${r.domain}`)) && r.policies.includes(policy));
  const deviceBlock = d?.dns_block.some((a) => domain === a || domain.endsWith(`.${a}`));
  const listed = BLOCKED_BY[policy]?.includes(cat) || !!blockRule || deviceBlock;
  if (!listed) return 'allow';
  return mode === 'monitor' ? 'would_block' : 'block';
}

/** Hour-bucketed category counts per device for the last 24 h. */
export interface Traffic {
  hours: number[]; // bucket start times
  byDevice: Map<string, { cats: Partial<Record<DnsCategory, number>>[]; domains: Map<string, { cat: DnsCategory; n: number }> }>;
}

export function buildTraffic(devices: Device[]): Traffic {
  const r = mulberry32(7);
  const end = Math.floor(NOW / H) * H;
  const hours = Array.from({ length: 24 }, (_, i) => end - (23 - i) * H);
  const byDevice: Traffic['byDevice'] = new Map();
  for (const d of devices) {
    const cats: Partial<Record<DnsCategory, number>>[] = [];
    const domains = new Map<string, { cat: DnsCategory; n: number }>();
    for (const t of hours) {
      const total = Math.round(BASE_RATE[d.kind] * activity(d, t) * between(0.78, 1.22, r));
      const bucket: Partial<Record<DnsCategory, number>> = {};
      const wsum = CAT_WEIGHTS[d.kind].reduce((a, [, w]) => a + w, 0);
      for (const [cat, w] of CAT_WEIGHTS[d.kind]) {
        const n = Math.round((total * w) / wsum * between(0.7, 1.3, r));
        if (!n) continue;
        bucket[cat] = n;
        const list = DOMAINS[d.kind][cat];
        if (!list) continue;
        const ws = list.reduce((a, [, x]) => a + x, 0);
        for (const [dom, x] of list) {
          const k = Math.round((n * x) / ws);
          if (!k) continue;
          const e = domains.get(dom) ?? { cat, n: 0 };
          e.n += k;
          domains.set(dom, e);
        }
      }
      cats.push(bucket);
    }
    byDevice.set(d.id, { cats, domains });
  }
  return { hours, byDevice };
}

export function summarize(traffic: Traffic, devices: Device[], rules: DnsRule[], unknownMode = 'monitor'): DnsSummary {
  const series = traffic.hours.map((t) => ({ t, queries: 0, blocked: 0, would_block: 0 }));
  const byCat: Partial<Record<DnsCategory, number>> = {};
  const dom = new Map<string, DnsDomainStat>();
  const byDevice: DnsSummary['by_device'] = [];
  for (const d of devices) {
    const tr = traffic.byDevice.get(d.id);
    if (!tr) continue;
    let dq = 0, db = 0, dw = 0;
    tr.cats.forEach((bucket, i) => {
      for (const [cat, n] of Object.entries(bucket) as [DnsCategory, number][]) {
        series[i].queries += n;
        byCat[cat] = (byCat[cat] ?? 0) + n;
        dq += n;
        // the dominant domain in a category decides blocking for the bucket
        const sample = DOMAINS[d.kind][cat]?.[0]?.[0] ?? 'x.invalid';
        const a = actionFor(d, cat, sample, unknownMode, rules);
        if (a === 'block') {
          series[i].blocked += n;
          db += n;
        } else if (a === 'would_block') {
          series[i].would_block += n;
          dw += n;
        }
      }
    });
    byDevice.push({ device_id: d.id, name: d.name, kind: d.kind, queries: dq, blocked: db, would_block: dw });
    for (const [domain, { cat, n }] of tr.domains) {
      const a = actionFor(d, cat, domain, unknownMode, rules);
      const s = dom.get(domain) ?? { domain, category: cat, vendor: vendorOf(domain), queries: 0, blocked: 0, would_block: 0, devices: 0, first_seen: firstSeen(domain), last_seen: NOW - Math.round(between(5, 600)) * S, rule: ruleFor(domain, rules) };
      s.queries += n;
      if (a === 'block') s.blocked += n;
      if (a === 'would_block') s.would_block += n;
      s.devices = (s.devices ?? 0) + 1;
      dom.set(domain, s);
    }
  }
  const all = [...dom.values()];
  const totals = series.reduce((a, p) => ({ q: a.q + p.queries, b: a.b + p.blocked, w: a.w + p.would_block }), { q: 0, b: 0, w: 0 });
  return {
    hours: 24,
    queries: totals.q,
    blocked: totals.b,
    would_block: totals.w,
    by_category: byCat,
    series,
    top_domains: [...all].sort((a, b) => b.queries - a.queries).slice(0, 12),
    top_blocked: all.filter((x) => x.blocked + x.would_block > 0).sort((a, b) => b.blocked + b.would_block - (a.blocked + a.would_block)).slice(0, 12),
    by_device: byDevice.sort((a, b) => b.queries - a.queries),
  };
}

export function allDomainStats(traffic: Traffic, devices: Device[], rules: DnsRule[]): DnsDomainStat[] {
  const dom = new Map<string, DnsDomainStat>();
  for (const d of devices) {
    const tr = traffic.byDevice.get(d.id);
    if (!tr) continue;
    for (const [domain, { cat, n }] of tr.domains) {
      const a = actionFor(d, cat, domain, 'monitor', rules);
      const x = dom.get(domain) ?? { domain, category: cat, vendor: vendorOf(domain), queries: 0, blocked: 0, would_block: 0, devices: 0, first_seen: firstSeen(domain), last_seen: NOW - (domain.length % 9) * 47 * S, rule: ruleFor(domain, rules) };
      x.queries += n * 7; // ~7 days
      if (a === 'block') x.blocked += n * 7;
      if (a === 'would_block') x.would_block += n * 7;
      x.devices = (x.devices ?? 0) + 1;
      dom.set(domain, x);
    }
  }
  return [...dom.values()].sort((a, b) => b.queries - a.queries);
}

export const NEW_DOMAINS = new Set([
  'acr-eu-prd.samsungcloud.tv', 'api.samba.tv', 'aic-ngfts.lge.com', 'firebase-settings.crashlytics.com', 'data.flurry.com',
  'imasdk.googleapis.com', 'd2ef20sk9hi1u3.cloudfront.net', 'tkacr316.alphonso.tv', 'us.info.samsungads.com', 'd3q1u2y8z1v1nw.cloudfront.net',
]);

export function firstSeen(domain: string): number {
  let h = 0;
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  if (NEW_DOMAINS.has(domain)) return NOW - ((h % 140) / 20 + 0.2) * D;
  return NOW - (20 + (h % 90)) * D;
}

export function ruleFor(domain: string, rules: DnsRule[]): 'block' | 'allow' | null {
  const r = rules.find((x) => x.source === 'user' && (domain === x.domain || domain.endsWith(`.${x.domain}`)));
  return r?.action ?? null;
}

const VENDORS: [RegExp, string][] = [
  [/samsung|2o7\.net/, 'Samsung'], [/lge|lgtv|lgsmart|lgapps|lgthinq|cjpowercast/, 'LG'], [/alphonso/, 'Alphonso'], [/samba\.tv/, 'Samba TV'],
  [/nvidia|nvgs/, 'NVIDIA'], [/sonos/, 'Sonos'], [/netflix|nflx/, 'Netflix'], [/google|gstatic|doubleclick|googlesyndication|googlevideo|app-measurement|crashlytics/, 'Google'],
  [/amazon/, 'Amazon'], [/spotify/, 'Spotify'], [/facebook|instagram/, 'Meta'], [/scorecardresearch/, 'comScore'], [/mixpanel/, 'Mixpanel'], [/flurry/, 'Yahoo'],
  [/appcenter/, 'Microsoft'], [/plex/, 'Plex'], [/stan/, 'Stan'], [/bamgrid|disney/, 'Disney'], [/apple|icloud/, 'Apple'], [/tiktok/, 'TikTok'],
];
export function vendorOf(domain: string): string | null {
  return VENDORS.find(([re]) => re.test(domain))?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Log entries

export interface SiteCtx { siteId: string; devices: Device[]; unknownMode: string; rules: DnsRule[]; guestSubnet: string }

let liveRng = mulberry32(99);

export function makeEntry(ctx: SiteCtx, ts: number, r = liveRng): DnsLogEntry {
  const active = ctx.devices.filter((d) => d.status !== 'offline' || !d.last_seen || ts < d.last_seen);
  const weights = active.map((d) => [d, BASE_RATE[d.kind] * Math.max(0.05, activity(d, ts))] as const);
  const guestWeight = 60;
  const total = weights.reduce((a, [, w]) => a + w, 0) + guestWeight;
  let x = r() * total;
  let device: Device | null = null;
  for (const [d, w] of weights) {
    x -= w;
    if (x <= 0) {
      device = d;
      break;
    }
  }
  let cat: DnsCategory;
  let qname: string;
  let client: string;
  if (device) {
    cat = pickWeighted(CAT_WEIGHTS[device.kind], r);
    const list = DOMAINS[device.kind][cat] ?? DOMAINS[device.kind].essential ?? [['pool.ntp.org', 1]];
    qname = pickWeighted(list, r);
    client = device.ip ?? '0.0.0.0';
  } else {
    cat = pickWeighted(GUEST_CATS, r);
    qname = pickWeighted(GUEST_DOMAINS[cat] ?? [['www.google.com', 1]], r);
    client = `${ctx.guestSubnet}.${pick([112, 118, 131, 140], r)}`;
  }
  const action = actionFor(device, cat, qname, ctx.unknownMode, ctx.rules);
  const cached = action === 'allow' && r() < 0.45;
  const listName = cat === 'acr' ? 'Perflyst Smart TV' : cat === 'ads' ? 'HaGeZi Multi PRO' : cat === 'telemetry' ? 'HaGeZi Native Tracker' : cat === 'tracking' ? 'Perflyst Android tracking' : null;
  const curated = ctx.rules.find((ru) => qname === ru.domain || qname.endsWith(`.${ru.domain}`));
  const qtype = r() < 0.68 ? 'A' : r() < 0.9 ? 'AAAA' : 'HTTPS';
  return {
    ts,
    client,
    device_id: device?.id ?? null,
    device_name: device?.name ?? null,
    qname,
    qtype,
    action,
    cat,
    rule: action === 'allow' ? (curated?.action === 'allow' ? `rule:${curated.domain}` : null) : curated ? `${curated.source}:${curated.domain}` : listName ? `list:${listName}` : `category:${cat}`,
    rcode: 'NOERROR',
    answers: action === 'block' ? [qtype === 'AAAA' ? '::' : '0.0.0.0'] : qtype === 'A' ? [`${pick([23, 104, 142, 151, 172, 203], r)}.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}`] : qtype === 'AAAA' ? ['2404:6800:4006:80a::200e'] : [],
    ms: action === 'block' ? 0 : cached ? 0 : Math.round(between(6, 48, r)),
    cached,
  };
}

export function seedLog(ctx: SiteCtx, count = 400): DnsLogEntry[] {
  const r = mulberry32(ctx.siteId.length * 1337);
  const out: DnsLogEntry[] = [];
  let t = NOW;
  for (let i = 0; i < count; i++) {
    t -= Math.round(between(0.4, 9, r) * S);
    out.push(makeEntry(ctx, t, r));
  }
  return out;
}

export function resetLiveRng() {
  liveRng = mulberry32(Date.now() & 0xffff);
}

