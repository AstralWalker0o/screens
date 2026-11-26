import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Combine, Link2, Speaker, Unlink, Volume2, VolumeX } from 'lucide-react';
import type { Device, SonosZone } from '../../../shared/types';
import { api } from '../../api';
import { invalidate, useQuery } from '../../lib/query';
import { Button, Card, CardBody, CardHeader, IconButton } from '../ui';
import { sonosCommand, sonosFacts } from './lib';

/** "with Sub, 2 surrounds" for a room's bonded speakers. */
export function bondedText(z: Pick<SonosZone, 'bonded'>): string {
  const b = z.bonded ?? [];
  if (!b.length) return '';
  const subs = b.filter((x) => /sub/i.test(x.role)).length;
  const sur = b.filter((x) => /surround/i.test(x.role)).length;
  const other = b.length - subs - sur;
  const parts = [subs ? (subs > 1 ? `${subs} Subs` : 'Sub') : '', sur ? (sur > 1 ? `${sur} surrounds` : 'a surround') : '', other ? (b.find((x) => x.role === 'Right' || x.role === 'Left') ? 'stereo pair' : `${other} more`) : ''].filter(Boolean);
  return parts.length ? `with ${parts.join(', ')}` : '';
}

/** A volume slider that sends after a short pause and doesn't jump while dragging. */
export function VolumeSlider({ value, onCommit, label, disabled }: { value: number | null | undefined; onCommit: (v: number) => void; label: string; disabled?: boolean }) {
  const [v, setV] = useState(value ?? 0);
  const dragging = useRef(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!dragging.current && value != null) setV(value);
  }, [value]);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input
        type="range"
        min={0}
        max={100}
        value={v}
        aria-label={label}
        disabled={disabled || value == null}
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={() => (dragging.current = false)}
        onChange={(e) => {
          const n = Number(e.target.value);
          setV(n);
          clearTimeout(t.current);
          t.current = setTimeout(() => onCommit(n), 250);
        }}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--color-accent)]"
      />
      <span className="w-7 text-right text-xs font-medium text-fg tnum">{value == null ? '–' : v}</span>
    </div>
  );
}

export function GroupCard({ device }: { device: Device }) {
  const s = sonosFacts(device);
  const f = s.f;
  const caps = device.capabilities;
  const offline = device.status === 'offline';
  const siblings = useQuery(`devices:site:${device.site_id}`, () => api.devices.list({ site_id: device.site_id }));
  const sonosDevices = (siblings.data ?? []).filter((x) => x.kind === 'sonos');
  const deviceFor = (uuid: string) => sonosDevices.find((x) => sonosFacts(x).uuid === uuid);
  const selfRoom = f.bonded_to?.uuid ?? s.uuid;
  // Rooms come from the live topology; fall back to adopted speakers for facts written by older versions.
  const zones: SonosZone[] = s.zones.length ? s.zones : sonosDevices.map((x) => ({ uuid: sonosFacts(x).uuid, name: x.name, ip: x.ip ?? null, coordinator: sonosFacts(x).coordinator }));
  const others = zones.filter((z) => z.uuid !== selfRoom);
  const grouped = s.members.length > 1;
  const allTogether = zones.length > 1 && zones.every((z) => z.coordinator === s.coordinator);
  const [busy, setBusy] = useState<string | null>(null);
  const after = () => invalidate(`sonos-status:${device.id}`, `devices:site:${device.site_id}`, `sonos-site:${device.site_id}`);

  const act = async (key: string, command: string, args: Record<string, unknown>, success: string, error: string) => {
    setBusy(key);
    const r = await sonosCommand(device, command, args, { success, error });
    setBusy(null);
    after();
    return r;
  };

  return (
    <Card>
      <CardHeader
        title="Group"
        icon={Link2}
        subtitle="Grouped speakers play the same thing in sync."
        actions={caps.includes('group') && zones.length > 1 && !allTogether && (
          <Button size="sm" icon={Combine} loading={busy === 'party'} disabled={offline || busy !== null} onClick={() => act('party', 'party', {}, 'All rooms are now playing together', 'Couldn’t group all rooms')}>
            Group all rooms
          </Button>
        )}
      />
      <CardBody>
        {grouped && (
          <div className="mb-4 rounded-lg border border-line bg-surface-2/60 p-3">
            <div className="flex items-center gap-2">
              <IconButton
                icon={f.group?.muted ? VolumeX : Volume2}
                label={f.group?.muted ? 'Unmute the group' : 'Mute the group'}
                size="sm"
                variant={f.group?.muted ? 'soft' : 'ghost'}
                disabled={offline}
                onClick={() => void sonosCommand(device, 'group_mute', { mute: !f.group?.muted }, { invalidate: false }).then(after)}
              />
              <span className="w-24 shrink-0 text-sm font-medium text-fg">Group volume</span>
              <VolumeSlider value={f.group?.volume} label="Group volume" disabled={offline} onCommit={(level) => void sonosCommand(device, 'group_volume', { level }, { invalidate: false }).then(after)} />
            </div>
            <ul className="mt-2 space-y-1.5 border-t border-line pt-2">
              {s.members.map((m) => (
                <li key={m.uuid} className="flex items-center gap-2 pl-9">
                  <span className="w-24 shrink-0 truncate text-xs text-muted" title={m.name}>{m.name}</span>
                  <VolumeSlider
                    value={m.volume}
                    label={`Volume of ${m.name}`}
                    disabled={offline}
                    onCommit={(level) => void sonosCommand(device, 'volume', m.uuid === selfRoom ? { level } : { uuid: m.uuid, level }, { invalidate: false }).then(after)}
                  />
                </li>
              ))}
            </ul>
            {s.members.some((m) => m.volume == null) && <p className="mt-2 pl-9 text-[11px] text-subtle">Member volumes appear after the next status check.</p>}
          </div>
        )}
        {others.length === 0 ? (
          <p className="text-sm text-muted">This is the only Sonos room at the site.</p>
        ) : (
          <ul className="divide-y divide-line">
            {others.map((z) => {
              const d = deviceFor(z.uuid);
              const together = z.coordinator === s.coordinator;
              const playing = d ? sonosFacts(d).np : null;
              return (
                <li key={z.uuid} className="flex items-center gap-3 py-2.5">
                  <Speaker className="size-4 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">
                      {d ? <Link to={`/devices/${d.id}`} className="hover:underline">{z.name}</Link> : z.name}
                      {bondedText(z) && <span className="ml-1.5 text-xs font-normal text-subtle">{bondedText(z)}</span>}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {together ? 'In this group' : playing?.title && playing.state === 'PLAYING' ? `Playing ${playing.title}` : z.coordinator !== z.uuid ? 'In another group' : 'On its own'}
                      {!d && ' · not adopted in Screens'}
                    </p>
                  </div>
                  {caps.includes('group') && (together ? (
                    <Button size="sm" variant="ghost" icon={Unlink} loading={busy === z.uuid} disabled={offline || busy !== null} onClick={() => act(z.uuid, 'ungroup', { uuid: z.uuid }, `${z.name} left the group`, `Couldn’t remove ${z.name}`)}>
                      Remove
                    </Button>
                  ) : (
                    <Button size="sm" icon={Link2} loading={busy === z.uuid} disabled={offline || busy !== null} onClick={() => act(z.uuid, 'join', { coordinator_uuid: s.coordinator, uuid: z.uuid }, `${z.name} joined ${device.name}`, `Couldn’t add ${z.name}`)}>
                      Add to group
                    </Button>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
        {caps.includes('group') && grouped && (
          <Button className="mt-3" size="sm" variant="ghost" icon={Unlink} loading={busy === 'leave'} disabled={offline || busy !== null} onClick={() => act('leave', 'ungroup', {}, `${device.name} now plays on its own`, 'Couldn’t leave the group')}>
            Play this speaker on its own
          </Button>
        )}
      </CardBody>
    </Card>
  );
}
