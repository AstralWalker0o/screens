import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Bookmark, Clapperboard, Gamepad2, LayoutGrid, Lock, Music, Settings, Star, ToyBrick, Tv, Wifi, type LucideIcon } from 'lucide-react';
import type { CardSize, CardStyle, LauncherHome, RowIcon } from '../../../shared/launcher';
import { api } from '../../api';
import { useElementWidth, useNow } from '../../lib/hooks';
import { cn } from '../ui';
import { BRANDS, hue, initials, type BrandStyle } from './brands';

export const ROW_ICON: Record<RowIcon, LucideIcon | null> = {
  bookmark: Bookmark, media: Clapperboard, star: Star, tv: Tv, music: Music, games: Gamepad2, kids: ToyBrick, settings: Settings, apps: LayoutGrid, none: null,
};

/** Card sizes on a 1920 × 1080 screen (what the box renders at 1080p). */
export const CARD_PX: Record<CardStyle, Record<CardSize, [number, number]>> = {
  banner: { small: [256, 144], medium: [336, 189], large: [448, 252] },
  icon: { small: [136, 136], medium: [168, 168], large: [208, 208] },
  poster: { small: [168, 252], medium: [200, 300], large: [240, 360] },
};

const W = 1920;
const H = 1080;
const X0 = 112;           // safe-area left/right
const GAP = 32;           // between cards
const ROW_GAP = 44;
const HEADER = 60;
const LABEL = 52;
/** The focused row's cards are centred about 40 % down the screen (contract §3). */
const FOCUS_Y = Math.round(H * 0.4);

export interface PreviewApp { package: string; label: string | null; system?: boolean }

export function appLabel(pkg: string, home: LauncherHome, apps: Map<string, PreviewApp>): string {
  return home.tiles[pkg]?.label || apps.get(pkg)?.label || pkg.split('.').pop()!.replace(/^./, (c) => c.toUpperCase());
}

interface VRow { key: string; rowId: string | null; title: string; icon: RowIcon; card: CardStyle; size: CardSize; apps: string[] }

/** Rows as the box shows them: hidden/kiosk-filtered apps removed, All apps last. */
export function visibleRows(home: LauncherHome, inventory: PreviewApp[], kiosk?: { enabled: boolean; allowed: string[] } | null): VRow[] {
  const hidden = new Set(home.hidden);
  const allowed = kiosk?.enabled ? new Set(kiosk.allowed) : null;
  const ok = (p: string) => !hidden.has(p) && (!allowed || allowed.has(p));
  const rows: VRow[] = home.rows.map((r) => ({ key: r.id, rowId: r.id, title: r.title, icon: r.icon, card: r.card, size: r.size, apps: r.apps.filter(ok) }));
  if (home.all_apps.enabled) {
    const inRows = new Set(home.rows.flatMap((r) => r.apps));
    const byLabel = new Map(inventory.map((a) => [a.package, a]));
    const rest = inventory.filter((a) => !a.system && !inRows.has(a.package) && ok(a.package))
      .sort((a, b) => appLabel(a.package, home, byLabel).localeCompare(appLabel(b.package, home, byLabel)))
      .map((a) => a.package);
    if (rest.length) rows.push({ key: '__all', rowId: null, title: home.all_apps.title, icon: 'apps', card: 'banner', size: 'small', apps: rest });
  }
  return rows;
}

function fmtClock(t: number, h24: boolean) {
  const d = new Date(t);
  const m = String(d.getMinutes()).padStart(2, '0');
  return h24 ? `${String(d.getHours()).padStart(2, '0')}:${m}` : `${d.getHours() % 12 || 12}:${m}`;
}

// ---------------------------------------------------------------------------
// Card art

function tint(accent: string): string {
  return `linear-gradient(140deg, color-mix(in oklab, ${accent} 62%, #16181f) 0%, color-mix(in oklab, ${accent} 22%, #0b0c10) 100%)`;
}

function Mark({ kind, color, size }: { kind: BrandStyle['mark']; color: string; size: number }) {
  if (kind === 'play') {
    return (
      <span className="inline-flex shrink-0 items-center justify-center" style={{ width: size * 1.42, height: size, background: color, borderRadius: size * 0.28 }}>
        <span style={{ width: 0, height: 0, borderTop: `${size * 0.22}px solid transparent`, borderBottom: `${size * 0.22}px solid transparent`, borderLeft: `${size * 0.36}px solid #fff`, marginLeft: size * 0.08 }} />
      </span>
    );
  }
  if (kind === 'chevron') return <span className="shrink-0" style={{ width: size * 0.5, height: size, background: color, clipPath: 'polygon(0 0, 45% 0, 100% 50%, 45% 100%, 0 100%, 55% 50%)' }} />;
  if (kind === 'dot') return <span className="shrink-0 rounded-full" style={{ width: size * 0.7, height: size * 0.7, background: `radial-gradient(circle at 35% 35%, #fff, ${color}aa)` }} />;
  return null;
}

/** Round "app icon" used on icon cards and the banner fallback. */
function AppGlyph({ pkg, label, size }: { pkg: string; label: string; size: number }) {
  const b = BRANDS[pkg];
  const style: CSSProperties = b
    ? { background: b.bg, color: b.fg }
    : { background: `linear-gradient(145deg, oklch(0.66 0.14 ${hue(label)}), oklch(0.46 0.14 ${hue(label) + 25}))`, color: '#fff' };
  const text = b ? b.word.replace(/[^A-Za-z0-9+]/g, '').slice(0, 1) : initials(label);
  return (
    <span className="flex shrink-0 items-center justify-center font-bold" style={{ ...style, width: size, height: size, borderRadius: size * 0.24, fontSize: size * (text.length > 1 ? 0.38 : 0.5), boxShadow: '0 6px 18px rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.08)' }}>
      {text}
    </span>
  );
}

function Wordmark({ b, w, h, poster }: { b: BrandStyle; w: number; h: number; poster?: boolean }) {
  const fit = (w * (poster ? 0.78 : 0.7)) / Math.max(3, b.word.length * 0.56 + (b.mark ? 1.2 : 0));
  const size = Math.min(h * (poster ? 0.16 : 0.27), fit);
  return (
    <span className="flex items-center justify-center whitespace-nowrap" style={{ gap: size * 0.28, color: b.fg, fontSize: size, fontWeight: b.weight ?? 700, letterSpacing: b.tracking, fontStyle: b.italic ? 'italic' : undefined, lineHeight: 1 }}>
      {b.mark && b.mark !== 'plus' && b.mark !== 'swoosh' && <Mark kind={b.mark} color={b.markColor ?? b.fg} size={size * 0.9} />}
      <span className="relative">
        {b.word}
        {b.mark === 'plus' && <span style={{ color: b.markColor, fontStyle: 'normal', marginLeft: size * 0.05 }}>+</span>}
        {b.mark === 'swoosh' && <span className="absolute left-[8%] h-[0.09em] w-[70%] rounded-full" style={{ bottom: '-0.24em', background: b.markColor, transform: 'rotate(-4deg)' }} />}
      </span>
    </span>
  );
}

export function CardArt({ pkg, label, card, w, h, accent, tileUrl }: { pkg: string; label: string; card: CardStyle; w: number; h: number; accent: string; tileUrl?: string | null }) {
  if (tileUrl) return <img src={tileUrl} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />;
  const b = BRANDS[pkg];
  if (card === 'icon') {
    return (
      <div className="absolute inset-0 flex items-center justify-center" style={{ background: tint(accent) }}>
        <AppGlyph pkg={pkg} label={label} size={h * 0.56} />
      </div>
    );
  }
  if (b) {
    return (
      <div className="absolute inset-0 flex items-center justify-center" style={{ background: b.bg }}>
        <Wordmark b={b} w={w} h={h} poster={card === 'poster'} />
        {card === 'poster' && <span className="absolute inset-x-0 bottom-0 h-1/3" style={{ background: 'linear-gradient(0deg, rgb(0 0 0 / 0.45), transparent)' }} />}
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ background: tint(accent), gap: h * 0.08 }}>
      <AppGlyph pkg={pkg} label={label} size={Math.min(h, w) * (card === 'poster' ? 0.42 : 0.5)} />
      {card === 'poster' && <span className="max-w-[86%] truncate font-semibold text-white/90" style={{ fontSize: w * 0.1 }}>{label}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The preview

export interface TvPreviewProps {
  home: LauncherHome;
  accent: string;
  /** Apps known at the site (labels, All apps row). */
  inventory: PreviewApp[];
  kiosk?: { enabled: boolean; allowed: string[] } | null;
  /** Wallpaper / card art URL for an asset (defaults to the API's asset URL). */
  assetUrl?: (sha256: string, ext: string) => string;
  /** Row the editor is working on: the preview moves focus there. */
  activeRowId?: string | null;
  onActiveRowChange?: (rowId: string | null) => void;
  className?: string;
  /** Non-interactive thumbnail. */
  still?: boolean;
  footer?: ReactNode;
}

export function TvPreview({ home, accent, inventory, kiosk, assetUrl = api.launcher.assetUrl, activeRowId, onActiveRowChange, className, still, footer }: TvPreviewProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const scale = width ? width / W : 0;
  const now = useNow();
  const apps = useMemo(() => new Map(inventory.map((a) => [a.package, a])), [inventory]);
  const rows = useMemo(() => visibleRows(home, inventory, kiosk), [home, inventory, kiosk]);
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [cols, setCols] = useState<Record<string, number>>({});
  const [launched, setLaunched] = useState<string | null>(null);
  const launchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastActive = useRef<string | null | undefined>(undefined);

  const row = Math.min(focus.row, rows.length - 1);
  const navigable = rows.map((r) => r.apps.length > 0);

  // Follow the editor: when another row is being edited, move focus to it.
  useEffect(() => {
    if (activeRowId === lastActive.current) return;
    lastActive.current = activeRowId;
    if (!activeRowId) return;
    const i = rows.findIndex((r) => r.rowId === activeRowId);
    if (i >= 0 && i !== focus.row) setFocus({ row: i, col: Math.min(cols[rows[i].key] ?? 0, Math.max(0, rows[i].apps.length - 1)) });
  }, [activeRowId, rows, focus.row, cols]);
  useEffect(() => () => clearTimeout(launchTimer.current), []);

  const go = (r: number, c: number) => {
    setFocus({ row: r, col: c });
    if (r >= 0) {
      setCols((m) => ({ ...m, [rows[r].key]: c }));
      if (rows[r].rowId !== activeRowId) {
        lastActive.current = rows[r].rowId;
        onActiveRowChange?.(rows[r].rowId);
      }
    }
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (still) return;
    const { row: r, col: c } = { row, col: focus.col };
    const step = (from: number, dir: 1 | -1) => {
      for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (navigable[i]) return i;
      return null;
    };
    if (e.key === 'ArrowRight') { if (r >= 0 && c < rows[r].apps.length - 1) go(r, c + 1); }
    else if (e.key === 'ArrowLeft') { if (r >= 0 && c > 0) go(r, c - 1); }
    else if (e.key === 'ArrowDown') {
      const n = r < 0 ? step(-1, 1) : step(r, 1);
      if (n !== null) go(n, Math.min(c, rows[n].apps.length - 1));
    } else if (e.key === 'ArrowUp') {
      const n = r < 0 ? null : step(r, -1);
      if (n !== null) go(n, Math.min(c, rows[n].apps.length - 1));
      else if (home.top_bar.settings && r >= 0) setFocus({ row: -1, col: 0 });
    } else if (e.key === 'Enter' || e.key === ' ') {
      const pkg = r >= 0 ? rows[r].apps[c] : null;
      setLaunched(pkg ? `Opens ${appLabel(pkg, home, apps)}` : kiosk?.enabled ? 'Asks for the PIN, then opens Android settings' : 'Opens Android settings');
      clearTimeout(launchTimer.current);
      launchTimer.current = setTimeout(() => setLaunched(null), 1400);
    } else return;
    e.preventDefault();
  };

  // Vertical layout: each row's top, then shift so the focused row sits ~40 % down the screen.
  const labelSpace = home.focus.label === 'never' ? 0 : LABEL;
  const tops: number[] = [];
  let y = 0;
  for (const r of rows) {
    tops.push(y);
    y += HEADER + CARD_PX[r.card][r.size][1] + labelSpace + ROW_GAP;
  }
  const anchor = Math.max(0, row);
  const ar = rows[anchor];
  const shiftY = ar ? FOCUS_Y - (tops[anchor] + HEADER + CARD_PX[ar.card][ar.size][1] / 2) : FOCUS_Y;
  const wp = home.wallpaper ? assetUrl(home.wallpaper.asset, home.wallpaper.ext) : '';
  const clock = fmtClock(now, home.top_bar.clock_24h);
  const date = new Date(now).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const gearFocused = focus.row === -1 && !still;

  return (
    <div className={cn('select-none', className)}>
      <div className="rounded-[18px] bg-gradient-to-b from-[#26272b] to-[#111214] p-[1.1%] shadow-pop ring-1 ring-black/50">
        <div
          ref={ref}
          tabIndex={still ? -1 : 0}
          role={still ? 'img' : 'application'}
          aria-label={still ? 'Home screen preview' : 'TV home screen preview. Use the arrow keys like the TV remote.'}
          onKeyDown={onKey}
          className="relative aspect-video w-full overflow-hidden rounded-[8px] bg-black outline-none focus-visible:ring-4 focus-visible:ring-accent/60"
        >
          {scale > 0 && (
            <div className="absolute top-0 left-0 origin-top-left overflow-hidden text-white" style={{ width: W, height: H, transform: `scale(${scale})`, fontFamily: 'Roboto, "Google Sans", system-ui, sans-serif' }}>
              {/* wallpaper (or the built-in gradient) */}
              {wp ? (
                <img src={wp} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
              ) : (
                <div className="absolute inset-0" style={{ background: `radial-gradient(80% 70% at 88% 8%, ${accent}66 0%, transparent 60%), radial-gradient(70% 60% at 8% 100%, #3a1f6a88 0%, transparent 65%), linear-gradient(160deg, #1b2030 0%, #08090d 100%)` }} />
              )}
              <div className="absolute inset-0" style={{ background: `rgb(0 0 0 / ${home.wallpaper?.dim ?? 0})` }} />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgb(0 0 0 / 0.55) 0%, rgb(0 0 0 / 0) 42%), linear-gradient(0deg, rgb(0 0 0 / 0.6) 0%, rgb(0 0 0 / 0) 48%)' }} />

              {/* top bar */}
              <div className="absolute top-[52px] right-[96px] flex items-start gap-[40px]" style={{ textShadow: '0 2px 12px rgb(0 0 0 / 0.5)' }}>
                <div className="flex items-center gap-[34px] pt-[26px]">
                  {home.top_bar.network && <Wifi className="size-[54px] text-white/90" strokeWidth={2} aria-hidden />}
                  {home.top_bar.settings && (
                    <span
                      className={cn('relative flex size-[80px] items-center justify-center rounded-full transition-all duration-150', gearFocused ? 'bg-white text-black' : 'text-white/90')}
                      style={gearFocused ? { boxShadow: '0 0 0 3px #fff, 0 0 30px rgb(255 255 255 / 0.4)', transform: 'scale(1.1)' } : undefined}
                      onClick={() => !still && setFocus({ row: -1, col: 0 })}
                    >
                      <Settings className="size-[52px]" strokeWidth={2} aria-hidden />
                      {kiosk?.enabled && <Lock className="absolute -right-1 -bottom-1 size-[26px] rounded-full bg-black/70 p-[4px] text-white" aria-hidden />}
                    </span>
                  )}
                </div>
                {(home.top_bar.clock || home.top_bar.date) && (
                  <div className="text-right">
                    {home.top_bar.clock && <p className="text-[118px] leading-none font-extralight tracking-[-0.02em] tnum" style={{ fontWeight: 200 }}>{clock}</p>}
                    {home.top_bar.date && <p className="mt-[10px] text-[30px] font-light text-white/80">{date}</p>}
                  </div>
                )}
              </div>

              {/* rows */}
              <div className="absolute inset-x-0 top-0 transition-transform duration-300 ease-out" style={{ transform: `translateY(${shiftY}px)` }}>
                {rows.map((r, i) => {
                  const [cw, ch] = CARD_PX[r.card][r.size];
                  const Icon = ROW_ICON[r.icon];
                  const isRow = i === row && focus.row >= 0;
                  const col = isRow ? focus.col : Math.min(cols[r.key] ?? 0, Math.max(0, r.apps.length - 1));
                  const span = W - 2 * X0;
                  const scrollX = Math.min(0, span - (col * (cw + GAP) + cw * 1.1));
                  const above = i < anchor;
                  return (
                    <section
                      key={r.key}
                      className="absolute inset-x-0 transition-opacity duration-300"
                      style={{ top: tops[i], opacity: above ? 0 : i > anchor + 2 ? 0.55 : 1 }}
                      aria-hidden={above}
                    >
                      <h4
                        className="flex items-center gap-[14px] text-[34px] font-medium text-white/95"
                        style={{ paddingLeft: X0, height: HEADER - 10, textShadow: '0 2px 10px rgb(0 0 0 / 0.55)' }}
                        onClick={() => !still && r.rowId && onActiveRowChange?.(r.rowId)}
                      >
                        {Icon && <Icon className="size-[34px]" strokeWidth={2.2} aria-hidden />}
                        {r.title || (Icon ? '' : ' ')}
                      </h4>
                      <div className="relative transition-transform duration-200 ease-out" style={{ height: ch + labelSpace, transform: `translateX(${scrollX}px)` }}>
                        {r.apps.length === 0 && (
                          <div className="absolute flex items-center justify-center rounded-[14px] border-[3px] border-dashed border-white/35 text-[24px] text-white/60" style={{ left: X0, width: Math.max(cw, 360), height: ch }}>
                            No apps in this row yet
                          </div>
                        )}
                        {r.apps.map((pkg, k) => {
                          const focused = !still && isRow && k === col;
                          const label = appLabel(pkg, home, apps);
                          const t = home.tiles[pkg];
                          const tileUrl = t?.asset && t.ext ? assetUrl(t.asset, t.ext) : null;
                          const showLabel = home.focus.label === 'always' || (home.focus.label === 'focused' && focused);
                          return (
                            <div key={pkg} className="absolute" style={{ left: X0 + k * (cw + GAP), top: 0, width: cw, zIndex: focused ? 2 : 1 }}>
                              <div
                                className="relative overflow-hidden rounded-[14px] transition-[transform,box-shadow] duration-150 ease-out"
                                style={{
                                  width: cw, height: ch, transformOrigin: 'center center',
                                  transform: focused ? `scale(${home.focus.scale})` : undefined,
                                  boxShadow: focused ? '0 0 0 3px #fff, 0 20px 50px rgb(0 0 0 / 0.55), 0 0 40px rgb(255 255 255 / 0.28)' : '0 10px 26px rgb(0 0 0 / 0.38)',
                                }}
                                onClick={() => !still && go(i, k)}
                              >
                                <CardArt pkg={pkg} label={label} card={r.card} w={cw} h={ch} accent={accent} tileUrl={tileUrl} />
                              </div>
                              {showLabel && (
                                <p className="truncate text-center text-[27px] text-white/95" style={{ marginTop: focused ? 10 + ((home.focus.scale - 1) * ch) / 2 : 12, textShadow: '0 2px 8px rgb(0 0 0 / 0.6)' }}>
                                  {label}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>

              {launched && (
                <div className="absolute bottom-[64px] left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-[36px] py-[16px] text-[30px] font-medium text-white shadow-2xl ring-1 ring-white/15">
                  {launched}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mx-auto h-[7px] w-[22%] rounded-b-[10px] bg-gradient-to-b from-[#1e1f22] to-[#0c0c0e]" aria-hidden />
      {footer}
    </div>
  );
}
