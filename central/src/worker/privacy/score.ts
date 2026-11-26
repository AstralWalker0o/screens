import type { ChecklistItem, DeviceKind, DevicePrivacy, DnsMode, DnsSummary, MicUsage, PrivacyFactor } from '../../shared/types';
import { CHECKLISTS } from './checklists';

export interface ScoreInput {
  kind: DeviceKind;
  dns_mode: DnsMode;
  online: boolean;
  summary: DnsSummary;          // last 24 h for this device
  last_query_at: number | null; // newest DNS query seen from this device
  checklist_done: Record<string, boolean>;
  mic: MicUsage[];
  private_dns: boolean;
  acr_unblocked: number;        // ACR lookups in 24 h that were not blocked
}

const BYPASS_WINDOW = 2 * 3_600_000;

export function grade(score: number): DevicePrivacy['grade'] {
  return score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
}

export function scoreDevice(i: ScoreInput, t = Date.now()): { score: number; grade: DevicePrivacy['grade']; factors: PrivacyFactor[]; checklist: ChecklistItem[]; bypass_suspected: boolean } {
  const factors: PrivacyFactor[] = [];
  let score = 100;
  const add = (f: PrivacyFactor) => { factors.push(f); score += f.impact; };
  const usesDns = i.last_query_at != null && t - i.last_query_at < 24 * 3_600_000;
  const bypass = i.kind !== 'sonos' && i.online && (i.last_query_at == null || t - i.last_query_at > BYPASS_WINDOW) && i.dns_mode !== 'bypass';

  if (i.kind !== 'sonos' || usesDns) {
    if (bypass) {
      add({ key: 'bypass', label: 'DNS not going through Screens', impact: -35, status: 'bad', detail: i.last_query_at == null ? 'No DNS lookups have ever been seen from this device. Point its DNS at the gateway, or it may be using hard-coded DNS (e.g. 8.8.8.8).' : 'The device is online but no lookups were seen in the last 2 hours. It may be using hard-coded DNS.' });
    } else if (usesDns) {
      add({ key: 'dns', label: 'DNS routed through Screens', impact: 0, status: 'good' });
    }
  }
  if (i.dns_mode === 'off' || i.dns_mode === 'bypass') add({ key: 'mode', label: 'DNS filtering is switched off', impact: -20, status: 'bad' });
  else if (i.dns_mode === 'monitor') add({ key: 'mode', label: 'Monitoring only (not blocking yet)', impact: -5, status: 'warn', detail: 'Screens is learning what this device talks to. Blocking starts automatically after the monitoring period.' });

  const cats = i.summary.by_category;
  const acrTotal = cats.acr ?? 0;
  const acrAllowed = i.acr_unblocked;
  if (acrAllowed > 0) add({ key: 'acr', label: 'Viewing tracking (ACR) is getting through', impact: -25, status: 'bad', detail: `${acrAllowed} ACR lookups in the last 24 h were not blocked. This is the TV reporting what is on screen.` });
  else if (acrTotal > 0) add({ key: 'acr', label: `ACR blocked (${acrTotal} attempts in 24 h)`, impact: 0, status: 'good', detail: 'The TV is still trying to send viewing data. Turning ACR off on the TV stops the attempts.' });

  const leaky = i.summary.would_block;
  if (leaky > 0) add({ key: 'leaks', label: 'Ads/telemetry lookups allowed', impact: -Math.min(20, Math.ceil(leaky / 50)), status: 'warn', detail: `${leaky} lookups in the last 24 h would be blocked once enforcement is on.` });
  if (i.summary.blocked > 0) add({ key: 'blocked', label: `${i.summary.blocked} tracker lookups blocked in 24 h`, impact: 0, status: 'good' });

  const micApps = i.mic.filter((m) => m.granted);
  if (micApps.length) add({ key: 'mic', label: `${micApps.length} app(s) can use the microphone`, impact: -Math.min(15, micApps.length * 3), status: 'warn', detail: micApps.map((m) => m.label ?? m.package).join(', ') });

  const checklist: ChecklistItem[] = (CHECKLISTS[i.kind] ?? []).map((c) => {
    let done = !!i.checklist_done[c.key];
    if (c.key === 'dns_routed') done = usesDns && !bypass;
    return { ...c, done };
  });
  if (i.kind === 'android' && i.private_dns) add({ key: 'pdns', label: 'Private DNS (encrypted) pointed at the gateway', impact: 0, status: 'good' });
  const open = checklist.filter((c) => !c.done && !c.auto).length;
  if (open) add({ key: 'checklist', label: `${open} privacy setting(s) on the device not confirmed`, impact: -Math.min(20, open * 4), status: 'warn' });

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, grade: grade(score), factors, checklist, bypass_suspected: bypass };
}
