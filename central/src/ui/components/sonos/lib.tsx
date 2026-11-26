import { useState } from 'react';
import { Music, type LucideIcon } from 'lucide-react';
import type { CommandResult, Device, SonosFacts, SonosNowPlaying, SonosSource } from '../../../shared/types';
import { sendCommand } from '../../lib/commands';
import { invalidate, setQueryData } from '../../lib/query';
import { toast } from '../../lib/toast';
import { cn } from '../ui';

/** Reads `device.facts` as SonosFacts with defaults. */
export function sonosFacts(d: Device) {
  const f = d.facts as unknown as Partial<SonosFacts>;
  const np = f.now_playing ?? null;
  const uuid = f.uuid ?? d.id;
  return {
    f, np, uuid,
    position: f.position ?? null,
    playing: isPlaying(np?.state),
    volume: typeof np?.volume === 'number' ? np.volume : 0,
    muted: !!np?.muted,
    led: typeof f.led === 'boolean' ? f.led : null,
    eq: f.eq ?? null,
    coordinator: f.group?.coordinator ?? uuid,
    members: f.group?.members ?? [],
    zones: f.zones ?? [],
  };
}

export const isPlaying = (state?: string | null) => state === 'PLAYING' || state === 'TRANSITIONING';

export const mmss = (s?: number | null) => {
  if (s == null || !Number.isFinite(s)) return '–:––';
  const v = Math.max(0, Math.floor(s));
  return v >= 3600 ? `${Math.floor(v / 3600)}:${String(Math.floor((v % 3600) / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}` : `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

/**
 * Image URL for Sonos album art: speaker-relative paths ("/getaa?…") go through the authenticated
 * proxy (any speaker at the site can serve them); public https URLs and data: URIs load directly.
 */
export function artSrc(deviceId: string, art?: string | null): string | undefined {
  if (!art) return undefined;
  if (art.startsWith('/')) return `/api/devices/${encodeURIComponent(deviceId)}/sonos/art?path=${encodeURIComponent(art)}`;
  if (/^(https?:|data:image\/)/i.test(art)) return art;
  return undefined;
}

export const SOURCE_LABEL: Record<SonosSource, string> = {
  music: 'Music', radio: 'Radio', tv: 'TV', line_in: 'Line-in', airplay: 'AirPlay', spotify_connect: 'Spotify Connect', app: 'Another app', none: '',
};

/** "YouTube Music", "Radio · TuneIn", "TV"… */
export function sourceText(np?: Pick<SonosNowPlaying, 'source' | 'service'> | null): string {
  if (!np?.source || np.source === 'none') return '';
  if (np.source === 'music') return np.service ?? '';
  if (np.source === 'radio') return np.service ? `Radio · ${np.service}` : 'Radio';
  if (np.source === 'app') return np.service ? `${np.service} (from the app)` : 'Controlled by another app';
  return SOURCE_LABEL[np.source];
}

/** Album art with a graceful fallback (missing art, proxy 404, offline gateway). */
export function Art({ deviceId, art, icon: Icon = Music, className, iconClassName }: { deviceId: string; art?: string | null; icon?: LucideIcon; className?: string; iconClassName?: string }) {
  const src = artSrc(deviceId, art);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={cn('flex shrink-0 items-center justify-center overflow-hidden', className)}>
      {src && failed !== src ? (
        <img src={src} alt="" className="size-full object-cover" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(src)} />
      ) : (
        <Icon className={cn('opacity-80', iconClassName)} aria-hidden />
      )}
    </span>
  );
}

/** Merge facts returned by a command into the cached device (so the card updates without waiting for a refresh). */
export function mergeFacts(deviceId: string, patch: Record<string, unknown> | undefined | null) {
  if (!patch) return;
  const keys = ['now_playing', 'position', 'group', 'zones', 'play_mode', 'crossfade', 'sleep_timer', 'transport', 'eq', 'ht', 'led', 'button_lock', 'bonded_to', 'status_at'];
  const picked = Object.fromEntries(Object.entries(patch).filter(([k, v]) => keys.includes(k) && v !== undefined));
  if (!Object.keys(picked).length) return;
  setQueryData<Device>(`device:${deviceId}`, (old) => old && { ...old, facts: { ...old.facts, ...picked } });
}

/** Send a Sonos command; merges returned facts and shows the adapter's `detail` (e.g. how Play recovered). */
export async function sonosCommand(
  device: Pick<Device, 'id' | 'site_id'>, command: string, args?: Record<string, unknown>,
  opts: { success?: string; error?: string; invalidate?: string[] | false; showDetail?: boolean } = {},
): Promise<CommandResult | undefined> {
  const r = await sendCommand(device.id, command, args, {
    success: opts.success, error: opts.error, invalidate: opts.invalidate === undefined ? [`device:${device.id}`] : opts.invalidate,
  });
  const data = r?.data as Record<string, unknown> | undefined;
  // `args.uuid` means the command acted on another room: this device's facts didn't change.
  if (!args?.uuid) mergeFacts(device.id, data);
  if (opts.showDetail !== false && typeof data?.detail === 'string' && !opts.success) toast.info(String(data.detail));
  // What's playing / the group changed: re-read the live status (play mode, skip/seek availability, members).
  if (CHANGES_STATUS.has(command)) setTimeout(() => invalidate(`sonos-status:${device.id}`, `sonos-queue:${device.id}`), 400);
  return r;
}

const CHANGES_STATUS = new Set(['media', 'play_favorite', 'play_queue', 'play_input', 'join', 'group', 'ungroup', 'party', 'clear_queue', 'remove_from_queue', 'group_volume', 'group_mute']);
