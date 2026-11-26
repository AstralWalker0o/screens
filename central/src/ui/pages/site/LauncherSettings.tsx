import { useEffect, useMemo, useState } from 'react';
import { PartyPopper, Wifi, Plus, Trash2, ArrowUp, ArrowDown, Save, Undo2, LayoutGrid, Lock, Pin, PinOff, House, TvMinimalPlay } from 'lucide-react';
import type { DeviceApp, KioskConfig, SiteDetail, WelcomeConfig } from '../../../shared/types';
import { api } from '../../api';
import { act, setQueryData, useQuery } from '../../lib/query';
import { useElementWidth } from '../../lib/hooks';
import { Badge, Button, Callout, Card, CardBody, CardHeader, IconButton, SectionLabel, StatusText, cn } from '../../components/ui';
import { Checkbox, Field, Input, SearchInput, Select, Textarea, Toggle } from '../../components/forms';
import { AppIcon } from '../../components/AppLauncher';
import { LauncherActions, LauncherStatusText } from '../../components/Launcher';
import { KindIcon, DeviceStatusBadge } from '../../components/status';

const MAX_SECTIONS = 8;

/** Union of apps seen on the site's Android devices: user apps first, then system apps. */
export function useSiteApps(site: SiteDetail) {
  const androids = site.devices.filter((d) => d.kind === 'android');
  return useQuery(androids.length ? `site-apps:${site.id}` : null, async () => {
    const lists = await Promise.all(androids.map((d) => api.devices.apps(d.id).catch(() => [] as DeviceApp[])));
    const m = new Map<string, DeviceApp>();
    for (const l of lists) for (const a of l) if (!m.has(a.package)) m.set(a.package, a);
    return [...m.values()].sort((a, b) => Number(a.system) - Number(b.system) || (a.label ?? a.package).localeCompare(b.label ?? b.package));
  });
}

async function saveGuest(site: SiteDetail, guest: Parameters<typeof api.sites.update>[1]['settings'], success: string) {
  const r = await act(() => api.sites.update(site.id, { settings: guest }), { success, invalidate: ['sites'] });
  if (r) setQueryData(`site:${site.id}`, () => r);
  return r;
}

// ---------------------------------------------------------------------------
// Launcher on each Android box

export function LauncherDevicesCard({ site }: { site: SiteDetail }) {
  const androids = site.devices.filter((d) => d.capabilities.includes('launcher'));
  return (
    <Card>
      <CardHeader
        title="Screens Launcher on each box"
        icon={House}
        subtitle="A simple home screen for Android TV boxes that shows the welcome screen and only the apps you allow. It has no internet access of its own — Screens configures it over the local network."
      />
      <CardBody>
        {androids.length === 0 ? (
          <p className="text-sm text-muted">No Android TV boxes here yet. The launcher works on NVIDIA Shield and other Android TV devices.</p>
        ) : (
          <ul className="divide-y divide-line">
            {androids.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <KindIcon kind={d.kind} boxed />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{d.name}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <LauncherStatusText device={d} />
                      {d.status !== 'online' && <DeviceStatusBadge status={d.status} />}
                    </div>
                  </div>
                </div>
                <LauncherActions device={d} compact />
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Welcome screen

export function WelcomeCard({ site }: { site: SiteDetail }) {
  const saved = site.settings.guest.welcome;
  const [w, setW] = useState<WelcomeConfig>(structuredClone(saved));
  const [afterReset, setAfterReset] = useState(site.settings.guest.show_welcome_after_reset);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setW(structuredClone(site.settings.guest.welcome));
    setAfterReset(site.settings.guest.show_welcome_after_reset);
  }, [site.settings.guest.welcome, site.settings.guest.show_welcome_after_reset]);
  const dirty = JSON.stringify(w) !== JSON.stringify(saved) || afterReset !== site.settings.guest.show_welcome_after_reset;
  const set = (p: Partial<WelcomeConfig>) => setW({ ...w, ...p });
  const setSection = (i: number, p: Partial<WelcomeConfig['sections'][number]>) => set({ sections: w.sections.map((s, k) => (k === i ? { ...s, ...p } : s)) });
  const move = (i: number, dir: -1 | 1) => {
    const n = [...w.sections];
    const j = i + dir;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    set({ sections: n });
  };
  const accentOk = /^#[0-9a-f]{6}$/i.test(w.accent);

  const save = async () => {
    setBusy(true);
    await saveGuest(site, { guest: { welcome: w, show_welcome_after_reset: afterReset } }, 'Welcome screen saved. Boxes with the launcher get it within a minute.');
    setBusy(false);
  };

  return (
    <Card>
      <CardHeader title="Welcome screen" icon={PartyPopper} subtitle="What guests see when they turn on the TV: Wi-Fi details, house info and who to contact." />
      <CardBody>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="space-y-4">
            <Toggle checked={w.enabled} onChange={(v) => set({ enabled: v })} label="Show a welcome screen" />
            <div className={cn('space-y-4', !w.enabled && 'pointer-events-none opacity-50')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Checkbox checked={w.show_on_boot} onChange={(v) => set({ show_on_boot: v })} label="When the box starts up" />
                <Checkbox checked={afterReset} onChange={setAfterReset} label="After every guest reset" />
              </div>
              <Field label="Title" htmlFor="wl-title"><Input id="wl-title" value={w.title} maxLength={60} onChange={(e) => set({ title: e.target.value })} placeholder={`Welcome to ${site.name}`} /></Field>
              <Field label="Message" htmlFor="wl-msg" optional><Textarea id="wl-msg" rows={2} maxLength={240} value={w.message} onChange={(e) => set({ message: e.target.value })} /></Field>

              <div className="rounded-lg border border-line p-3">
                <Toggle
                  size="sm"
                  checked={!!w.wifi}
                  onChange={(v) => set({ wifi: v ? { ssid: '', password: '', security: 'WPA' } : null })}
                  label={<span className="inline-flex items-center gap-1.5"><Wifi className="size-3.5" aria-hidden />Show Wi-Fi details and a QR code</span>}
                  description="Guests scan the code with their phone camera to join."
                />
                {w.wifi && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_130px]">
                    <Field label="Network name" htmlFor="wl-ssid"><Input id="wl-ssid" value={w.wifi.ssid} onChange={(e) => set({ wifi: { ...w.wifi!, ssid: e.target.value } })} /></Field>
                    <Field label="Password" htmlFor="wl-pass"><Input id="wl-pass" mono value={w.wifi.password} disabled={w.wifi.security === 'nopass'} onChange={(e) => set({ wifi: { ...w.wifi!, password: e.target.value } })} /></Field>
                    <Field label="Security" htmlFor="wl-sec">
                      <Select id="wl-sec" value={w.wifi.security} onChange={(e) => set({ wifi: { ...w.wifi!, security: e.target.value as 'WPA' | 'WEP' | 'nopass' } })}>
                        <option value="WPA">WPA/WPA2</option>
                        <option value="WEP">WEP</option>
                        <option value="nopass">Open</option>
                      </Select>
                    </Field>
                  </div>
                )}
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <SectionLabel className="mb-0">Info sections</SectionLabel>
                  <span className="text-xs text-subtle">{w.sections.length}/{MAX_SECTIONS}</span>
                </div>
                <ul className="space-y-2">
                  {w.sections.map((s, i) => (
                    <li key={i} className="rounded-lg border border-line p-2.5">
                      <div className="flex items-center gap-1.5">
                        <Input value={s.title} onChange={(e) => setSection(i, { title: e.target.value })} placeholder="Heading, e.g. Checkout" aria-label={`Section ${i + 1} heading`} maxLength={40} />
                        <IconButton icon={ArrowUp} label="Move up" size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
                        <IconButton icon={ArrowDown} label="Move down" size="sm" disabled={i === w.sections.length - 1} onClick={() => move(i, 1)} />
                        <IconButton icon={Trash2} label="Remove section" size="sm" variant="danger-ghost" onClick={() => set({ sections: w.sections.filter((_, k) => k !== i) })} />
                      </div>
                      <Textarea className="mt-1.5 min-h-14" rows={2} value={s.body} onChange={(e) => setSection(i, { body: e.target.value })} placeholder="Please check out by 10 am." aria-label={`Section ${i + 1} text`} maxLength={300} />
                    </li>
                  ))}
                </ul>
                <Button size="sm" variant="ghost" icon={Plus} className="mt-1.5" disabled={w.sections.length >= MAX_SECTIONS} onClick={() => set({ sections: [...w.sections, { title: '', body: '' }] })}>Add section</Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
                <Field label="Contact line" htmlFor="wl-contact" optional><Input id="wl-contact" value={w.contact} maxLength={120} onChange={(e) => set({ contact: e.target.value })} placeholder="Questions? Text us on 0400 000 000" /></Field>
                <Field label="Accent colour" htmlFor="wl-accent" error={accentOk ? null : 'Use a #RRGGBB colour'}>
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label="Pick accent colour" value={accentOk ? w.accent : '#4f8ef7'} onChange={(e) => set({ accent: e.target.value })} className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface p-0.5" />
                    <Input id="wl-accent" mono value={w.accent} onChange={(e) => set({ accent: e.target.value })} />
                  </div>
                </Field>
              </div>
            </div>
          </div>

          <div>
            <SectionLabel>Preview</SectionLabel>
            <WelcomePreview w={w} siteName={site.name} />
            <p className="mt-2 text-xs text-muted">Roughly how it looks on a TV. Guests press “Start watching” to get to the apps.</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
          {dirty && <span className="mr-auto text-sm text-muted">Unsaved changes</span>}
          {dirty && <Button variant="ghost" icon={Undo2} onClick={() => { setW(structuredClone(saved)); setAfterReset(site.settings.guest.show_welcome_after_reset); }}>Discard</Button>}
          <Button variant="primary" icon={Save} loading={busy} disabled={!dirty || !accentOk} onClick={save}>Save welcome screen</Button>
        </div>
      </CardBody>
    </Card>
  );
}

/** A placeholder that looks like a QR code (the real one is drawn on the TV). */
function QrPlaceholder({ seed, size }: { seed: string; size: number }) {
  const n = 21;
  let h = 2166136261;
  for (const c of seed || 'wifi') h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const cells: [number, number][] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const finder = (x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12);
      if (finder) continue;
      h = Math.imul(h ^ (x * 31 + y), 2654435761) >>> 0;
      if (h % 100 < 45) cells.push([x, y]);
    }
  }
  const finder = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={7} height={7} fill="#111" />
      <rect x={x + 1} y={y + 1} width={5} height={5} fill="#fff" />
      <rect x={x + 2} y={y + 2} width={3} height={3} fill="#111" />
    </g>
  );
  return (
    <svg viewBox={`-1 -1 ${n + 2} ${n + 2}`} width={size} height={size} className="rounded-md bg-white" role="img" aria-label="Wi-Fi QR code (placeholder)">
      {cells.map(([x, y]) => <rect key={`${x}.${y}`} x={x} y={y} width={1} height={1} fill="#111" />)}
      {finder(0, 0)}
      {finder(n - 7, 0)}
      {finder(0, n - 7)}
    </svg>
  );
}

export function WelcomePreview({ w, siteName }: { w: WelcomeConfig; siteName: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const scale = width ? width / 960 : 0;
  const accent = /^#[0-9a-f]{6}$/i.test(w.accent) ? w.accent : '#4f8ef7';
  return (
    <div ref={ref} className="relative aspect-video w-full overflow-hidden rounded-xl border-[6px] border-[#16171a] bg-[#0d0f14] shadow-pop" aria-label="Welcome screen preview">
      {scale > 0 && (
        <div
          className="absolute top-0 left-0 origin-top-left text-white"
          style={{ width: 960, height: 540, transform: `scale(${scale})`, background: `radial-gradient(120% 90% at 0% 0%, ${accent}40 0%, transparent 55%), linear-gradient(180deg, #151821 0%, #0b0d12 100%)`, fontFamily: 'Roboto, system-ui, sans-serif' }}
        >
          {!w.enabled ? (
            <div className="flex h-full items-center justify-center text-2xl text-white/50">Welcome screen is off</div>
          ) : (
            <div className="flex h-full gap-10 p-14">
              <div className="flex min-w-0 flex-1 flex-col">
                <p className="text-[15px] font-medium tracking-[0.2em] uppercase" style={{ color: accent }}>{siteName}</p>
                <h3 className="mt-2 text-[46px] leading-[1.05] font-bold [overflow-wrap:anywhere]">{w.title || `Welcome to ${siteName}`}</h3>
                {w.message && <p className="mt-4 text-[20px] leading-snug text-white/75">{w.message}</p>}
                {w.sections.length > 0 && (
                  <div className="mt-7 grid grid-cols-2 gap-3">
                    {w.sections.slice(0, 4).map((s, i) => (
                      <div key={i} className="rounded-2xl bg-white/[0.07] px-5 py-4 ring-1 ring-white/10">
                        <p className="text-[16px] font-semibold">{s.title || 'Section'}</p>
                        <p className="mt-1 line-clamp-3 text-[14px] leading-snug text-white/65">{s.body}</p>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-auto flex items-center gap-6 pt-6">
                  <span className="shrink-0 rounded-full px-7 py-3 text-[18px] font-semibold whitespace-nowrap text-white shadow-lg" style={{ background: accent }}>Start watching</span>
                  {w.contact && <p className="min-w-0 truncate text-[16px] text-white/60">{w.contact}</p>}
                </div>
              </div>
              {w.wifi && (
                <div className="flex w-[250px] shrink-0 flex-col items-center self-start rounded-3xl bg-white/[0.08] p-6 ring-1 ring-white/10">
                  <p className="flex items-center gap-2 text-[16px] font-semibold"><Wifi className="size-5" style={{ color: accent }} />Wi-Fi</p>
                  <div className="mt-4"><QrPlaceholder seed={`${w.wifi.ssid}:${w.wifi.password}`} size={150} /></div>
                  <p className="mt-4 text-[13px] text-white/55">Network</p>
                  <p className="max-w-full truncate text-[19px] font-semibold">{w.wifi.ssid || '—'}</p>
                  {w.wifi.security !== 'nopass' && (
                    <>
                      <p className="mt-2 text-[13px] text-white/55">Password</p>
                      <p className="max-w-full truncate font-mono text-[18px]">{w.wifi.password || '—'}</p>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kiosk

export function KioskCard({ site }: { site: SiteDetail }) {
  const saved = site.settings.guest.kiosk;
  const strip = (k: KioskConfig): KioskConfig => ({ enabled: k.enabled, allowed: k.allowed, pinned: k.pinned, force_home: k.force_home });
  const [k, setK] = useState<KioskConfig>(strip(saved));
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [search, setSearch] = useState('');
  const apps = useSiteApps(site);
  useEffect(() => setK(strip(site.settings.guest.kiosk)), [site.settings.guest.kiosk]);
  const dirty = JSON.stringify(k) !== JSON.stringify(strip(saved));
  const byPkg = useMemo(() => new Map((apps.data ?? []).map((a) => [a.package, a])), [apps.data]);
  const label = (p: string) => byPkg.get(p)?.label ?? p;
  const pinOk = /^\d{4,8}$/.test(pin);

  const toggleAllowed = (p: string, v: boolean) => setK({ ...k, allowed: v ? [...k.allowed, p] : k.allowed.filter((x) => x !== p), pinned: v ? k.pinned : k.pinned.filter((x) => x !== p) });
  const togglePinned = (p: string) => setK({ ...k, pinned: k.pinned.includes(p) ? k.pinned.filter((x) => x !== p) : [...k.pinned, p], allowed: k.allowed.includes(p) ? k.allowed : [...k.allowed, p] });
  const movePinned = (i: number, dir: -1 | 1) => {
    const n = [...k.pinned];
    const j = i + dir;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    setK({ ...k, pinned: n });
  };

  const s = search.trim().toLowerCase();
  const visible = (apps.data ?? []).filter((a) => !s || (a.label ?? '').toLowerCase().includes(s) || a.package.includes(s));
  const missing = k.allowed.filter((p) => !byPkg.has(p));

  const save = async () => {
    setBusy(true);
    await saveGuest(site, { guest: { kiosk: k } }, 'Kiosk settings saved. Boxes with the launcher update within a minute.');
    setBusy(false);
  };
  const savePin = async (value: string) => {
    setPinBusy(true);
    const r = await saveGuest(site, { guest: { kiosk: { ...strip(saved), pin: value } } }, value ? 'Exit PIN set' : 'Exit PIN removed');
    setPinBusy(false);
    if (r) setPin('');
  };

  return (
    <Card>
      <CardHeader title="Kiosk mode" icon={LayoutGrid} subtitle="Guests only see the apps you choose, in your order. Android settings are locked behind a PIN." />
      <CardBody className="space-y-5">
        <Toggle checked={k.enabled} onChange={(v) => setK({ ...k, enabled: v })} label="Only show chosen apps" description="Needs the Screens Launcher on the box. Without kiosk mode the launcher shows every TV app." />
        <div className={cn('grid gap-5 lg:grid-cols-2', !k.enabled && 'opacity-60')}>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <SectionLabel className="mb-0">Allowed apps ({k.allowed.length})</SectionLabel>
            </div>
            <SearchInput value={search} onChange={setSearch} placeholder="Find an app" className="mb-2" />
            <ul className="max-h-80 space-y-0.5 overflow-y-auto rounded-lg border border-line p-1">
              {apps.loading && <li className="p-3 text-sm text-muted">Loading apps from the site’s boxes…</li>}
              {!apps.loading && !visible.length && <li className="p-3 text-sm text-muted">{(apps.data ?? []).length ? 'No apps match.' : 'No apps seen yet on this site’s Android boxes.'}</li>}
              {visible.map((a, i) => (
                <li key={a.package}>
                  {i > 0 && a.system && !visible[i - 1].system && <p className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">System apps</p>}
                  <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2">
                    <Checkbox checked={k.allowed.includes(a.package)} onChange={(v) => toggleAllowed(a.package, v)} ariaLabel={`Allow ${a.label ?? a.package}`} />
                    <AppIcon app={a} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-fg">{a.label ?? a.package}</p>
                      <p className="truncate font-mono text-[11px] text-muted">{a.package}</p>
                    </div>
                    <IconButton icon={k.pinned.includes(a.package) ? PinOff : Pin} label={k.pinned.includes(a.package) ? 'Unpin' : 'Pin to the front'} size="sm" variant={k.pinned.includes(a.package) ? 'soft' : 'ghost'} onClick={() => togglePinned(a.package)} />
                  </div>
                </li>
              ))}
            </ul>
            {missing.length > 0 && <p className="mt-1.5 text-xs text-muted">Also allowed but not installed yet: {missing.map(label).join(', ')}</p>}
          </div>
          <div className="space-y-5">
            <div>
              <SectionLabel>Order on the home screen</SectionLabel>
              {k.pinned.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line-strong p-4 text-sm text-muted">Pin apps (<Pin className="inline size-3.5" aria-hidden />) to put them first, in your order. Other allowed apps follow alphabetically.</p>
              ) : (
                <ol className="space-y-1">
                  {k.pinned.map((p, i) => (
                    <li key={p} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5">
                      <span className="w-5 text-center text-xs text-subtle tnum">{i + 1}</span>
                      <AppIcon app={{ label: label(p), package: p, icon: byPkg.get(p)?.icon }} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{label(p)}</span>
                      <IconButton icon={ArrowUp} label={`Move ${label(p)} up`} size="sm" disabled={i === 0} onClick={() => movePinned(i, -1)} />
                      <IconButton icon={ArrowDown} label={`Move ${label(p)} down`} size="sm" disabled={i === k.pinned.length - 1} onClick={() => movePinned(i, 1)} />
                      <IconButton icon={PinOff} label={`Unpin ${label(p)}`} size="sm" onClick={() => togglePinned(p)} />
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-sm font-medium text-fg"><Lock className="size-3.5" aria-hidden />Exit PIN</p>
                {saved.pin_set ? <StatusText tone="ok" icon={Lock}>PIN set</StatusText> : <Badge>No PIN</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted">Long-press the clock on the launcher and enter this PIN to reach Android settings. 4–8 digits.</p>
              <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (pinOk) void savePin(pin); }}>
                <Input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder={saved.pin_set ? 'New PIN' : 'Choose a PIN'} aria-label="Exit PIN" mono className="w-40" />
                <Button type="submit" size="md" loading={pinBusy && !!pin} disabled={!pinOk}>{saved.pin_set ? 'Change PIN' : 'Set PIN'}</Button>
                {saved.pin_set && <Button variant="danger-ghost" disabled={pinBusy} onClick={() => savePin('')}>Clear</Button>}
              </form>
            </div>
            <Toggle
              checked={k.force_home}
              onChange={(v) => setK({ ...k, force_home: v })}
              label="Force as home screen"
              description="Also disables the stock Google TV / Android TV launcher so the Home button always comes back to Screens. Needed on some Google TV builds; removing the launcher turns the stock one back on."
            />
          </div>
        </div>
        {k.enabled && k.allowed.length === 0 && <Callout kind="warn">Kiosk mode is on but no apps are allowed — guests would see an empty home screen.</Callout>}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
          {dirty && <span className="mr-auto text-sm text-muted">Unsaved changes</span>}
          {dirty && <Button variant="ghost" icon={Undo2} onClick={() => setK(strip(saved))}>Discard</Button>}
          <Button variant="primary" icon={Save} loading={busy} disabled={!dirty} onClick={save}>Save kiosk settings</Button>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted"><TvMinimalPlay className="size-3.5" aria-hidden />Saving sends the new settings to every box that has the Screens Launcher.</p>
      </CardBody>
    </Card>
  );
}
