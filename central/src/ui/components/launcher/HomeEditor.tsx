import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, EyeOff, Image as ImageIcon, ImagePlus, Paintbrush, PanelTop, Plus, Rows3, Trash2, Upload, X, GripVertical, Type, CircleAlert,
} from 'lucide-react';
import {
  CARD_SIZES, CARD_STYLES, LABEL_MODES, LAUNCHER_LIMITS, newRowId, PACKAGE_RE, ROW_ICONS, type CardSize, type CardStyle, type LabelMode, type LauncherHome,
  type LauncherRow, type LauncherTile, type RowIcon,
} from '../../../shared/launcher';
import { api, type SiteApp } from '../../api';
import { useElementWidth } from '../../lib/hooks';
import { errorMessage } from '../../lib/query';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, CardBody, CardHeader, IconButton, SectionLabel, cn } from '../ui';
import { Checkbox, Field, Input, SearchInput, Segmented, Toggle } from '../forms';
import { Dialog } from '../overlay';
import { BRANDS, hue, initials } from './brands';
import { CardArt, ROW_ICON } from './TvPreview';
import { cardImage, wallpaperJpeg } from './images';

export const ICON_LABEL: Record<RowIcon, string> = {
  bookmark: 'Bookmark', media: 'Media', star: 'Star', tv: 'TV', music: 'Music', games: 'Games', kids: 'Kids', settings: 'Settings', apps: 'Apps', none: 'No icon',
};
const CARD_LABEL: Record<CardStyle, string> = { banner: 'Banner', icon: 'Icon', poster: 'Poster' };
const CARD_HINT: Record<CardStyle, string> = { banner: 'Wide 16:9 TV banner (the Projectivy look)', icon: 'Square app icon on a tinted card', poster: 'Tall 2:3 poster' };
const SIZE_LABEL: Record<CardSize, string> = { small: 'S', medium: 'M', large: 'L' };
const LABEL_MODE: Record<LabelMode, string> = { always: 'Always', focused: 'When selected', never: 'Never' };

/** Small app glyph for chips and lists (brand colour, else initials). */
export function AppDot({ pkg, label, className }: { pkg: string; label: string; className?: string }) {
  const b = BRANDS[pkg];
  const text = b ? b.word.replace(/[^A-Za-z0-9]/g, '').slice(0, 1) : initials(label);
  return (
    <span
      className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold ring-1 ring-black/10', className)}
      style={b ? { background: b.bg, color: b.fg } : { background: `oklch(0.55 0.13 ${hue(label)})`, color: '#fff' }}
      aria-hidden
    >
      {text}
    </span>
  );
}

const DRAG_TYPE = 'application/x-screens-app';

export interface HomeEditorProps {
  home: LauncherHome;
  onChange: (h: LauncherHome) => void;
  accent: string | null;
  onAccentChange: (a: string | null) => void;
  welcomeAccent: string;
  inventory: SiteApp[];
  activeRowId: string | null;
  onActiveRowChange: (id: string | null) => void;
  kiosk: { enabled: boolean; allowed: string[] };
}

export function HomeEditor(p: HomeEditorProps) {
  const { home, onChange } = p;
  const labels = useMemo(() => new Map(p.inventory.map((a) => [a.package, a.label ?? a.package])), [p.inventory]);
  const label = (pkg: string) => home.tiles[pkg]?.label || labels.get(pkg) || pkg;
  return (
    <div className="@container space-y-4">
      <RowsCard {...p} label={label} known={labels} />
      <LookCard {...p} />
      <BarCard home={home} onChange={onChange} />
      <HiddenCard home={home} onChange={onChange} inventory={p.inventory} label={label} />
      <TilesCard home={home} onChange={onChange} inventory={p.inventory} label={label} accent={p.accent ?? p.welcomeAccent} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows

function RowsCard({ home, onChange, inventory, activeRowId, onActiveRowChange, label, known, kiosk }: HomeEditorProps & { label: (p: string) => string; known: Map<string, string> }) {
  const [picker, setPicker] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ row: string; pkg: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const setRows = (rows: LauncherRow[]) => onChange({ ...home, rows });
  const setRow = (id: string, patch: Partial<LauncherRow>) => setRows(home.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const moveRow = (i: number, dir: -1 | 1) => {
    const rows = [...home.rows];
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    setRows(rows);
  };
  const addRow = () => {
    const id = newRowId('New row', home.rows.map((r) => r.id));
    setRows([...home.rows, { id, title: 'New row', icon: 'star', card: 'banner', size: 'medium', apps: [] }]);
    onActiveRowChange(id);
  };
  const moveApp = (rowId: string, from: number, to: number) => {
    const r = home.rows.find((x) => x.id === rowId)!;
    if (to < 0 || to >= r.apps.length) return;
    const apps = [...r.apps];
    const [x] = apps.splice(from, 1);
    apps.splice(to, 0, x);
    setRow(rowId, { apps });
  };
  /** Drop `drag` before `beforePkg` (or at the end) of row `toRow`, across rows too. */
  const drop = (toRow: string, beforePkg: string | null) => {
    if (!drag) return;
    const rows = home.rows.map((r) => ({ ...r, apps: [...r.apps] }));
    const src = rows.find((r) => r.id === drag.row);
    const dst = rows.find((r) => r.id === toRow);
    if (!src || !dst) return;
    if (dst !== src && dst.apps.includes(drag.pkg)) { toast.info(`${label(drag.pkg)} is already in “${dst.title || 'that row'}”`); return; }
    if (dst !== src && dst.apps.length >= LAUNCHER_LIMITS.apps_per_row) { toast.info(`A row can hold at most ${LAUNCHER_LIMITS.apps_per_row} apps`); return; }
    src.apps = src.apps.filter((x) => x !== drag.pkg);
    const at = beforePkg ? dst.apps.indexOf(beforePkg) : -1;
    if (at < 0) dst.apps.push(drag.pkg);
    else dst.apps.splice(at, 0, drag.pkg);
    setRows(rows);
    onActiveRowChange(toRow);
  };
  const dragProps = (rowId: string, beforePkg: string | null, key: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (over !== key) setOver(key);
    },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOver(null);
      drop(rowId, beforePkg);
      setDrag(null);
    },
  });
  const pickerRow = home.rows.find((r) => r.id === picker);
  const allowed = kiosk.enabled ? new Set(kiosk.allowed) : null;

  return (
    <Card>
      <CardHeader
        title="Rows"
        icon={Rows3}
        subtitle="Each row has a small heading and a strip of app cards. Drag apps to reorder them or move them between rows."
        actions={<Button size="sm" icon={Plus} onClick={addRow} disabled={home.rows.length >= LAUNCHER_LIMITS.rows}>Add row</Button>}
      />
      <CardBody className="space-y-3">
        {home.rows.map((r, i) => {
          const active = r.id === activeRowId;
          const Icon = ROW_ICON[r.icon];
          return (
            <section
              key={r.id}
              id={`row-${r.id}`}
              aria-label={`Row ${i + 1}: ${r.title || 'untitled'}`}
              onFocusCapture={() => !active && onActiveRowChange(r.id)}
              onClick={() => !active && onActiveRowChange(r.id)}
              className={cn('rounded-xl border p-3 transition-colors', active ? 'border-accent/60 bg-accent-soft/30 ring-3 ring-accent/10' : 'border-line bg-surface')}
            >
              <div className="flex items-center gap-1.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted" aria-hidden>
                  {Icon ? <Icon className="size-4" /> : <Type className="size-4" />}
                </span>
                <Input
                  value={r.title}
                  maxLength={LAUNCHER_LIMITS.title}
                  onChange={(e) => setRow(r.id, { title: e.target.value })}
                  placeholder="Row heading (optional)"
                  aria-label={`Row ${i + 1} heading`}
                  className="flex-1"
                />
                <IconButton icon={ArrowUp} label="Move row up" size="sm" disabled={i === 0} onClick={() => moveRow(i, -1)} />
                <IconButton icon={ArrowDown} label="Move row down" size="sm" disabled={i === home.rows.length - 1} onClick={() => moveRow(i, 1)} />
                <IconButton icon={Trash2} label="Delete row" size="sm" variant="danger-ghost" disabled={home.rows.length <= 1} onClick={() => setRows(home.rows.filter((x) => x.id !== r.id))} />
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                <div role="radiogroup" aria-label="Row icon" className="flex flex-wrap gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5">
                  {ROW_ICONS.map((ic) => {
                    const I = ROW_ICON[ic];
                    const on = r.icon === ic;
                    return (
                      <button
                        key={ic}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={ICON_LABEL[ic]}
                        title={ICON_LABEL[ic]}
                        onClick={() => setRow(r.id, { icon: ic })}
                        className={cn('flex size-6 items-center justify-center rounded-md transition-colors', on ? 'bg-surface text-fg shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg')}
                      >
                        {I ? <I className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                      </button>
                    );
                  })}
                </div>
                <Segmented size="sm" ariaLabel="Card style" value={r.card} onChange={(v) => setRow(r.id, { card: v })} options={CARD_STYLES.map((c) => ({ value: c, label: CARD_LABEL[c], title: CARD_HINT[c] }))} />
                <Segmented size="sm" ariaLabel="Card size" value={r.size} onChange={(v) => setRow(r.id, { size: v })} options={CARD_SIZES.map((s) => ({ value: s, label: SIZE_LABEL[s], title: `${s[0].toUpperCase()}${s.slice(1)} cards` }))} />
              </div>

              <div
                className={cn('mt-2.5 flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-dashed p-1.5 transition-colors', over === `${r.id}:end` ? 'border-accent bg-accent-soft/40' : 'border-line-strong/70')}
                {...dragProps(r.id, null, `${r.id}:end`)}
              >
                {r.apps.length === 0 && <span className="px-1.5 text-xs text-muted">No apps yet. Add some, or drag them here from another row.</span>}
                {r.apps.map((pkg, k) => {
                  const missing = !known.has(pkg);
                  const blocked = allowed && !allowed.has(pkg);
                  const hidden = home.hidden.includes(pkg);
                  return (
                    <div
                      key={pkg}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_TYPE, pkg);
                        e.dataTransfer.effectAllowed = 'move';
                        setDrag({ row: r.id, pkg });
                      }}
                      onDragEnd={() => { setDrag(null); setOver(null); }}
                      {...dragProps(r.id, pkg, `${r.id}:${pkg}`)}
                      title={missing ? `${pkg} isn’t installed on any box here yet. Boxes skip it until it is.` : blocked ? 'Kiosk mode is on and this app isn’t allowed, so guests won’t see it.' : hidden ? 'This app is hidden everywhere.' : pkg}
                      className={cn(
                        'group flex max-w-full cursor-grab items-center gap-1 rounded-lg border bg-surface py-0.5 pr-0.5 pl-1 text-sm shadow-card active:cursor-grabbing',
                        over === `${r.id}:${pkg}` ? 'border-accent ring-2 ring-accent/30' : 'border-line',
                        drag?.pkg === pkg && drag.row === r.id && 'opacity-40',
                        (missing || blocked || hidden) && 'border-dashed',
                      )}
                    >
                      <GripVertical className="size-3.5 shrink-0 text-subtle" aria-hidden />
                      <AppDot pkg={pkg} label={label(pkg)} />
                      <span className={cn('min-w-0 truncate px-0.5 text-[13px]', (missing || blocked || hidden) && 'text-muted line-through decoration-subtle/60')}>{label(pkg)}</span>
                      <IconButton icon={ArrowLeft} label={`Move ${label(pkg)} earlier`} size="xs" disabled={k === 0} onClick={() => moveApp(r.id, k, k - 1)} />
                      <IconButton icon={ArrowRight} label={`Move ${label(pkg)} later`} size="xs" disabled={k === r.apps.length - 1} onClick={() => moveApp(r.id, k, k + 1)} />
                      <IconButton icon={X} label={`Remove ${label(pkg)} from this row`} size="xs" variant="danger-ghost" onClick={() => setRow(r.id, { apps: r.apps.filter((x) => x !== pkg) })} />
                    </div>
                  );
                })}
                <Button size="xs" variant="ghost" icon={Plus} onClick={() => setPicker(r.id)} disabled={r.apps.length >= LAUNCHER_LIMITS.apps_per_row}>Add apps</Button>
              </div>
              <p className="mt-1 text-right text-[11px] text-subtle tnum">{r.apps.length}/{LAUNCHER_LIMITS.apps_per_row} apps</p>
            </section>
          );
        })}
        <p className="text-xs text-muted">Up to {LAUNCHER_LIMITS.rows} rows. Apps that aren’t installed on a box are skipped there.</p>
      </CardBody>
      <AppPicker
        open={!!pickerRow}
        onClose={() => setPicker(null)}
        title={pickerRow ? `Add apps to “${pickerRow.title || 'row'}”` : ''}
        inventory={inventory}
        exclude={pickerRow?.apps ?? []}
        max={LAUNCHER_LIMITS.apps_per_row - (pickerRow?.apps.length ?? 0)}
        onPick={(pkgs) => pickerRow && setRow(pickerRow.id, { apps: [...pickerRow.apps, ...pkgs].slice(0, LAUNCHER_LIMITS.apps_per_row) })}
      />
    </Card>
  );
}

/** Choose apps from the site's Android inventory (or type a package name). */
export function AppPicker({ open, onClose, title, inventory, exclude, onPick, max = 100, single, confirmLabel }: {
  open: boolean; onClose: () => void; title: ReactNode; inventory: SiteApp[]; exclude: string[]; onPick: (pkgs: string[]) => void; max?: number; single?: boolean; confirmLabel?: string;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [system, setSystem] = useState(false);
  const [custom, setCustom] = useState('');
  const close = () => { setSel([]); setQ(''); setCustom(''); onClose(); };
  const s = q.trim().toLowerCase();
  const list = inventory.filter((a) => (system || !a.system) && !exclude.includes(a.package) && (!s || (a.label ?? '').toLowerCase().includes(s) || a.package.includes(s)));
  const customOk = PACKAGE_RE.test(custom.trim()) && !exclude.includes(custom.trim());
  const toggle = (pkg: string, v: boolean) => setSel(single ? (v ? [pkg] : []) : v ? [...sel, pkg].slice(0, max) : sel.filter((x) => x !== pkg));
  const done = (pkgs: string[]) => { onPick(pkgs); close(); };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description="Apps seen on this site’s Android TV boxes."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!sel.length} onClick={() => done(sel)}>{confirmLabel ?? (sel.length > 1 ? `Add ${sel.length} apps` : 'Add app')}</Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={q} onChange={setQ} placeholder="Find an app" className="min-w-48 flex-1" />
        <Checkbox checked={system} onChange={setSystem} label="Show system apps" />
      </div>
      <ul className="mt-3 max-h-[46dvh] space-y-0.5 overflow-y-auto rounded-lg border border-line p-1">
        {!list.length && <li className="p-3 text-sm text-muted">{inventory.length ? 'No more apps match.' : 'No apps seen yet. Refresh the app list on a box’s Apps tab.'}</li>}
        {list.map((a) => (
          <li key={a.package}>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2">
              <Checkbox checked={sel.includes(a.package)} onChange={(v) => toggle(a.package, v)} ariaLabel={a.label ?? a.package} />
              <AppDot pkg={a.package} label={a.label ?? a.package} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{a.label ?? a.package}</span>
                <span className="block truncate font-mono text-[11px] text-muted">{a.package}</span>
              </span>
              {a.devices > 1 && <Badge>{a.devices} boxes</Badge>}
            </label>
          </li>
        ))}
      </ul>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (customOk) done([custom.trim()]); }}>
        <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Or type a package, e.g. org.jellyfin.androidtv" mono aria-label="Package name" className="flex-1" />
        <Button type="submit" disabled={!customOk}>Add</Button>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Wallpaper & look

function useUpload() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (file: File, kind: 'wallpaper' | 'card') => {
    try {
      setBusy('Resizing…');
      const blob = kind === 'wallpaper' ? await wallpaperJpeg(file) : await cardImage(file);
      setBusy('Uploading…');
      const a = await api.launcher.uploadAsset(blob, file.name.replace(/\.[^.]+$/, '') || 'picture');
      return a;
    } catch (e) {
      toast.error('Couldn’t use that picture', errorMessage(e));
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

function FileButton({ onFile, children, icon = Upload, disabled, size = 'sm', variant = 'secondary' }: { onFile: (f: File) => void; children: ReactNode; icon?: typeof Upload; disabled?: boolean; size?: 'xs' | 'sm'; variant?: 'secondary' | 'ghost' }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button size={size} variant={variant} icon={icon} disabled={disabled} onClick={() => ref.current?.click()}>{children}</Button>
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </>
  );
}

function Range({ value, min, max, step, onChange, label, display, disabled }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; display: string; disabled?: boolean }) {
  return (
    <div className={cn('flex items-center gap-3', disabled && 'opacity-50')}>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} className="h-1.5 min-w-0 flex-1 cursor-pointer accent-accent" />
      <span className="w-12 shrink-0 text-right text-sm text-fg tnum">{display}</span>
    </div>
  );
}

function LookCard({ home, onChange, accent, onAccentChange, welcomeAccent }: HomeEditorProps) {
  const up = useUpload();
  const wp = home.wallpaper;
  const custom = accent !== null;
  const shown = accent ?? welcomeAccent;
  const accentOk = /^#[0-9a-f]{6}$/i.test(shown);
  return (
    <Card>
      <CardHeader title="Wallpaper & look" icon={Paintbrush} />
      <CardBody className="space-y-5">
        <div className="grid gap-4 @lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
          <div className="relative aspect-video w-full max-w-80 overflow-hidden rounded-lg border border-line bg-[#0b0d12]">
            {wp ? (
              <img src={api.launcher.assetUrl(wp.asset, wp.ext)} alt="Current wallpaper" className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center text-xs text-white/60" style={{ background: `radial-gradient(80% 70% at 88% 8%, ${accentOk ? shown : '#4f8ef7'}66 0%, transparent 60%), linear-gradient(160deg, #1b2030 0%, #08090d 100%)` }}>Built-in dark gradient</div>
            )}
            {wp && <div className="pointer-events-none absolute inset-0" style={{ background: `rgb(0 0 0 / ${wp.dim})` }} />}
            {up.busy && <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-sm font-medium text-white">{up.busy}</div>}
          </div>
          <div className="min-w-0 space-y-3">
            <div>
              <SectionLabel>Wallpaper</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                <FileButton
                  icon={ImagePlus}
                  disabled={!!up.busy}
                  onFile={async (f) => {
                    const a = await up.run(f, 'wallpaper');
                    if (a) onChange({ ...home, wallpaper: { asset: a.sha256, ext: a.ext, dim: home.wallpaper?.dim ?? 0.25 } });
                  }}
                >
                  {wp ? 'Replace picture' : 'Upload picture'}
                </FileButton>
                {wp && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => onChange({ ...home, wallpaper: null })}>Use the gradient</Button>}
              </div>
              <p className="mt-1.5 text-xs text-muted">A landscape photo works best. Screens resizes it to 1920 × 1080 and compresses it before uploading.</p>
            </div>
            <div>
              <SectionLabel>Darken the wallpaper</SectionLabel>
              <Range label="Darken the wallpaper" value={wp?.dim ?? 0} min={0} max={LAUNCHER_LIMITS.dim_max} step={0.05} disabled={!wp} display={`${Math.round((wp?.dim ?? 0) * 100)}%`} onChange={(v) => wp && onChange({ ...home, wallpaper: { ...wp, dim: Math.round(v * 100) / 100 } })} />
              <p className="mt-1 text-xs text-muted">Keeps the clock and row titles readable on bright photos.</p>
            </div>
          </div>
        </div>

        <div className="grid gap-5 @lg:grid-cols-2">
          <div>
            <SectionLabel>Zoom on the selected app</SectionLabel>
            <Range label="Zoom on the selected app" value={home.focus.scale} min={LAUNCHER_LIMITS.scale_min} max={LAUNCHER_LIMITS.scale_max} step={0.01} display={`${Math.round(home.focus.scale * 100)}%`} onChange={(v) => onChange({ ...home, focus: { ...home.focus, scale: Math.round(v * 100) / 100 } })} />
          </div>
          <div>
            <SectionLabel>App names under the cards</SectionLabel>
            <Segmented size="sm" ariaLabel="App names" value={home.focus.label} onChange={(v) => onChange({ ...home, focus: { ...home.focus, label: v } })} options={LABEL_MODES.map((m) => ({ value: m, label: LABEL_MODE[m] }))} />
          </div>
        </div>

        <div>
          <SectionLabel>Accent colour</SectionLabel>
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox checked={!custom} onChange={(v) => onAccentChange(v ? null : welcomeAccent)} label="Same as the welcome screen" />
            <div className={cn('flex items-center gap-2', !custom && 'pointer-events-none opacity-50')}>
              <input type="color" aria-label="Pick accent colour" value={accentOk ? shown.toLowerCase() : '#4f8ef7'} onChange={(e) => onAccentChange(e.target.value.toUpperCase())} className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface p-0.5" />
              <Input mono value={shown} onChange={(e) => onAccentChange(e.target.value)} aria-label="Accent colour" className="w-28" />
            </div>
          </div>
          <p className="mt-1 text-xs text-muted">Tints app cards that have no TV banner, and the welcome screen on boxes with launcher 2.</p>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Top bar & All apps

function BarCard({ home, onChange }: { home: LauncherHome; onChange: (h: LauncherHome) => void }) {
  const tb = home.top_bar;
  const set = (patch: Partial<LauncherHome['top_bar']>) => onChange({ ...home, top_bar: { ...tb, ...patch } });
  return (
    <Card>
      <CardHeader title="Top bar & All apps" icon={PanelTop} />
      <CardBody className="space-y-3">
        <div className="grid gap-3 @lg:grid-cols-2">
          <Toggle size="sm" checked={tb.clock} onChange={(v) => set({ clock: v })} label="Clock" description="Large and thin, top right." />
          <Toggle size="sm" checked={tb.clock_24h} disabled={!tb.clock} onChange={(v) => set({ clock_24h: v })} label="24-hour clock" description="18:30 instead of 6:30." />
          <Toggle size="sm" checked={tb.date} onChange={(v) => set({ date: v })} label="Date" description="Under the clock." />
          <Toggle size="sm" checked={tb.network} onChange={(v) => set({ network: v })} label="Network icon" description="Wi-Fi or Ethernet." />
          <Toggle size="sm" checked={tb.settings} onChange={(v) => set({ settings: v })} label="Settings button" description="Opens Android settings. Needs the PIN in kiosk mode." />
        </div>
        <div className="border-t border-line pt-3">
          <Toggle checked={home.all_apps.enabled} onChange={(v) => onChange({ ...home, all_apps: { ...home.all_apps, enabled: v } })} label="All apps row" description="A last row with every other app on the box, A to Z (hidden apps never show)." />
          {home.all_apps.enabled && (
            <Field label="Row heading" htmlFor="all-apps-title" className="mt-2 max-w-sm">
              <Input id="all-apps-title" value={home.all_apps.title} maxLength={LAUNCHER_LIMITS.title} onChange={(e) => onChange({ ...home, all_apps: { ...home.all_apps, title: e.target.value } })} />
            </Field>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Hidden apps

function HiddenCard({ home, onChange, inventory, label }: { home: LauncherHome; onChange: (h: LauncherHome) => void; inventory: SiteApp[]; label: (p: string) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader title="Hidden apps" icon={EyeOff} subtitle="Never shown anywhere on the home screen, including All apps." actions={<Button size="sm" icon={Plus} onClick={() => setOpen(true)}>Hide apps</Button>} />
      <CardBody>
        {home.hidden.length === 0 ? (
          <p className="text-sm text-muted">Nothing hidden. Tip: hide the Play Store so guests can’t install apps.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {home.hidden.map((pkg) => (
              <li key={pkg} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface py-0.5 pr-0.5 pl-1 text-[13px]" title={pkg}>
                <AppDot pkg={pkg} label={label(pkg)} />
                <span className="max-w-48 truncate">{label(pkg)}</span>
                <IconButton icon={X} label={`Show ${label(pkg)} again`} size="xs" onClick={() => onChange({ ...home, hidden: home.hidden.filter((x) => x !== pkg) })} />
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <AppPicker
        open={open}
        onClose={() => setOpen(false)}
        title="Hide apps"
        inventory={inventory}
        exclude={home.hidden}
        max={LAUNCHER_LIMITS.hidden - home.hidden.length}
        confirmLabel="Hide"
        onPick={(pkgs) => onChange({ ...home, hidden: [...home.hidden, ...pkgs] })}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Per-app overrides (name and/or picture)

function TilesCard({ home, onChange, inventory, label, accent }: { home: LauncherHome; onChange: (h: LauncherHome) => void; inventory: SiteApp[]; label: (p: string) => string; accent: string }) {
  const [open, setOpen] = useState(false);
  const up = useUpload();
  const [busyPkg, setBusyPkg] = useState<string | null>(null);
  const entries = Object.entries(home.tiles);
  const setTile = (pkg: string, t: LauncherTile | null) => {
    const tiles = { ...home.tiles };
    if (t) tiles[pkg] = t;
    else delete tiles[pkg];
    onChange({ ...home, tiles });
  };
  const inRows = [...new Set(home.rows.flatMap((r) => r.apps))];
  // Apps placed in rows but not seen on a box can still get an override.
  const pickable: SiteApp[] = [
    ...inventory,
    ...inRows.filter((p) => !inventory.some((a) => a.package === p)).map((p) => ({ package: p, label: null, system: false, category: null, risk: null, devices: 0, kinds: ['android' as const] })),
  ];
  const accentOk = /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#4f8ef7';
  return (
    <Card>
      <CardHeader
        title="App names & pictures"
        icon={ImageIcon}
        subtitle="Rename an app on the TV or give it your own card picture. A custom picture replaces the app’s banner."
        actions={<Button size="sm" icon={Plus} onClick={() => setOpen(true)} disabled={entries.length >= LAUNCHER_LIMITS.tiles}>Customise an app</Button>}
      />
      <CardBody>
        {entries.length === 0 ? (
          <p className="text-sm text-muted">No customised apps.</p>
        ) : (
          <ul className="divide-y divide-line">
            {entries.map(([pkg, t]) => {
              const base = inventory.find((a) => a.package === pkg)?.label ?? pkg;
              return (
                <li key={pkg} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 @lg:flex-row @lg:items-center">
                  <div className="relative aspect-video w-full max-w-60 shrink-0 overflow-hidden rounded-lg @lg:w-36">
                    <ScaledArt pkg={pkg} label={t.label || base} accent={accentOk} tileUrl={t.asset && t.ext ? api.launcher.assetUrl(t.asset, t.ext) : null} />
                    {busyPkg === pkg && up.busy && <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-xs font-medium text-white">{up.busy}</div>}
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="truncate font-mono text-[11px] text-muted">{pkg}</p>
                    <Input value={t.label ?? ''} maxLength={LAUNCHER_LIMITS.label} placeholder={`Name on the TV (default: ${base})`} aria-label={`Name for ${base} on the TV`} onChange={(e) => setTile(pkg, { ...t, label: e.target.value || undefined })} />
                    <div className="flex flex-wrap gap-1.5">
                      <FileButton
                        size="xs"
                        icon={ImagePlus}
                        disabled={!!up.busy}
                        onFile={async (f) => {
                          setBusyPkg(pkg);
                          const a = await up.run(f, 'card');
                          setBusyPkg(null);
                          if (a) setTile(pkg, { ...home.tiles[pkg], asset: a.sha256, ext: a.ext });
                        }}
                      >
                        {t.asset ? 'Replace picture' : 'Upload picture'}
                      </FileButton>
                      {t.asset && <Button size="xs" variant="ghost" onClick={() => setTile(pkg, { label: t.label })}>Use the app’s banner</Button>}
                      <Button size="xs" variant="danger-ghost" icon={Trash2} onClick={() => setTile(pkg, null)}>Remove</Button>
                    </div>
                    {!t.label && !t.asset && <p className="flex items-center gap-1 text-xs text-warn-fg"><CircleAlert className="size-3.5" aria-hidden />Add a name or a picture, or remove this.</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      <AppPicker
        open={open}
        onClose={() => setOpen(false)}
        title="Customise an app"
        inventory={pickable}
        exclude={Object.keys(home.tiles)}
        single
        confirmLabel="Customise"
        onPick={([pkg]) => pkg && setTile(pkg, { label: label(pkg) === pkg ? undefined : label(pkg) })}
      />
    </Card>
  );
}

/** A 16:9 card thumbnail drawn at TV size and scaled down. */
function ScaledArt({ pkg, label, accent, tileUrl }: { pkg: string; label: string; accent: string; tileUrl: string | null }) {
  const [ref, w] = useElementWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden">
      {w > 0 && (
        <div className="absolute top-0 left-0 origin-top-left" style={{ width: 448, height: 252, transform: `scale(${w / 448})` }}>
          <CardArt pkg={pkg} label={label} card="banner" w={448} h={252} accent={accent} tileUrl={tileUrl} />
        </div>
      )}
    </div>
  );
}
