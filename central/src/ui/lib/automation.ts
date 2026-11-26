import type { Automation, AutomationAction, AutomationTarget, AutomationTrigger, Device, SiteSummary } from '../../shared/types';
import { describeCron } from './cron';
import { commandLabel, DNS_MODE, EVENTS, KIND, KEY_LABELS } from './labels';

export type Draft = Omit<Automation, 'id' | 'created_at' | 'last_run' | 'last_status'>;

export function describeTrigger(t: AutomationTrigger): string {
  return t.type === 'schedule' ? describeCron(t.cron, t.timezone) : `When ${EVENTS[t.event]?.label.toLowerCase() ?? t.event}`;
}

export function matchDevices(t: AutomationTarget, devices: Device[]): Device[] {
  return devices.filter((d) =>
    (!t.site_ids?.length || t.site_ids.includes(d.site_id)) && (!t.kinds?.length || t.kinds.includes(d.kind)) &&
    (!t.device_ids?.length || t.device_ids.includes(d.id)) && (!t.tags?.length || t.tags.some((g) => d.tags.includes(g))));
}

export function describeTarget(t: AutomationTarget, sites: SiteSummary[], devices: Device[]): string {
  if (t.device_ids?.length) {
    const names = t.device_ids.map((id) => devices.find((d) => d.id === id)?.name ?? 'a removed device');
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and ');
  }
  const kinds = t.kinds?.length ? t.kinds.map((k) => `${KIND[k].short}`).join(', ') : 'all devices';
  const where = t.site_ids?.length ? `at ${t.site_ids.map((id) => sites.find((s) => s.id === id)?.name ?? 'a removed site').join(', ')}` : 'at every site';
  const tags = t.tags?.length ? ` tagged ${t.tags.map((x) => `“${x}”`).join(' or ')}` : '';
  return `${t.kinds?.length ? `${kinds} devices` : kinds}${tags} ${where}`;
}

export function describeAction(a: AutomationAction): string {
  switch (a.type) {
    case 'command': {
      const args = a.args ?? {};
      if (a.command === 'key') return `Press ${KEY_LABELS[String(args.key)] ?? String(args.key ?? '?')}`;
      if (a.command === 'volume') return `Set volume to ${String(args.level ?? '?')}`;
      if (a.command === 'launch') return `Open ${String(args.package ?? args.app_id ?? 'an app')}`;
      if (a.command === 'toast') return `Show “${String(args.message ?? '')}”`;
      if (a.command === 'mute') return args.mute ? 'Mute' : 'Unmute';
      if (a.command === 'media') return `Media: ${String(args.action ?? '?')}`;
      return commandLabel(a.command);
    }
    case 'guest_reset': return 'Guest reset';
    case 'enforce_apps': return 'Apply app policies';
    case 'dns_mode': return `Set DNS to ${DNS_MODE[a.mode].label}`;
    case 'alert': return `Alert: “${a.title}”`;
    case 'delay': return `Wait ${a.seconds >= 60 && a.seconds % 60 === 0 ? `${a.seconds / 60} min` : `${a.seconds} s`}`;
  }
}

export const TEMPLATES: Record<string, (ctx: { siteId?: string }) => Draft> = {
  midnight: () => ({
    name: 'Turn all TVs off at midnight', enabled: true, scope_type: 'global', scope_id: null,
    trigger: { type: 'schedule', cron: '0 0 * * *', timezone: 'Australia/Sydney' },
    target: { kinds: ['samsung', 'lg', 'android'] },
    actions: [{ type: 'command', command: 'power_off' }],
  }),
  checkout: ({ siteId }) => ({
    name: 'Guest reset at 11 am checkout', enabled: true, scope_type: siteId ? 'site' : 'global', scope_id: siteId ?? null,
    trigger: { type: 'schedule', cron: '0 11 * * *', timezone: 'Australia/Sydney' },
    target: siteId ? { site_ids: [siteId] } : {},
    actions: [{ type: 'guest_reset' }, { type: 'delay', seconds: 90 }, { type: 'enforce_apps' }],
  }),
  offline: () => ({
    name: 'Alert when a device goes offline', enabled: true, scope_type: 'global', scope_id: null,
    trigger: { type: 'event', event: 'device.offline' }, target: {},
    actions: [{ type: 'alert', severity: 'warning', title: 'A device went offline' }],
  }),
};

export const TEMPLATE_INFO: { id: keyof typeof TEMPLATES; title: string; blurb: string }[] = [
  { id: 'midnight', title: 'Turn all TVs off at midnight', blurb: 'Every night, put every TV and box into standby.' },
  { id: 'checkout', title: 'Guest reset at 11 am checkout', blurb: 'Sign guests out of streaming apps and tidy up for the next stay.' },
  { id: 'offline', title: 'Alert when a device goes offline', blurb: 'Get an alert when a TV, box or speaker stops responding.' },
];

export function blankDraft(): Draft {
  return {
    name: '', enabled: true, scope_type: 'global', scope_id: null,
    trigger: { type: 'schedule', cron: '0 0 * * *', timezone: 'Australia/Sydney' }, target: {}, actions: [],
  };
}
