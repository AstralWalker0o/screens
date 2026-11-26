import { useEffect, useMemo, useState } from 'react';
import {
  Copy, CopyPlus, EllipsisVertical, House, LayoutTemplate, MonitorPlay, MonitorX, Pencil, Plus, Save, Sparkles, Trash2, Undo2, CircleCheck, Info, Keyboard, Lock,
} from 'lucide-react';
import { defaultHome, validateHome, type LauncherHome, type LauncherLayout, type LauncherSiteState } from '../../../shared/launcher';
import type { SiteDetail } from '../../../shared/types';
import { api, type SiteApp } from '../../api';
import { act, invalidate, setQueryData, useQuery } from '../../lib/query';
import { Badge, Button, Callout, Card, IconButton, SkeletonRows, StatusText, cn } from '../../components/ui';
import { Checkbox, Field, Input, Select } from '../../components/forms';
import { ConfirmDialog, Dialog, Menu } from '../../components/overlay';
import { TvPreview } from '../../components/launcher/TvPreview';
import { HomeEditor } from '../../components/launcher/HomeEditor';
import { BRANDS } from '../../components/launcher/brands';
import { LauncherRolloutCard, launcherSiteKey, useLauncherSite } from '../../components/launcher/Rollout';
import { useSiteApps } from './LauncherSettings';

interface Draft { id: string; updated_at: number; name: string; home: LauncherHome; accent: string | null }
const toDraft = (l: LauncherLayout): Draft => ({ id: l.id, updated_at: l.updated_at, name: l.name, home: structuredClone(l.home), accent: l.accent });
const sameAs = (d: Draft, l: LauncherLayout) => d.name === l.name && d.accent === l.accent && JSON.stringify(d.home) === JSON.stringify(l.home);

/** A first layout built from the apps on the site's boxes (the operator's Projectivy arrangement). */
export function suggestedHome(inventory: SiteApp[], kiosk?: { enabled: boolean; allowed: string[] }): LauncherHome {
  const user = inventory.filter((a) => !a.system && (!kiosk?.enabled || kiosk.allowed.includes(a.package)));
  const has = new Set(user.map((a) => a.package));
  const featured = ['org.jellyfin.androidtv', 'com.plexapp.android', 'com.netflix.ninja'].find((p) => has.has(p)) ?? user[0]?.package;
  const media = user.filter((a) => a.package !== featured && (a.category === 'streaming' || a.category === 'video' || !!BRANDS[a.package]) && a.category !== 'music').map((a) => a.package).slice(0, 12);
  const music = user.filter((a) => a.category === 'music' && a.package !== featured).map((a) => a.package);
  const rows: LauncherHome['rows'] = [];
  if (featured) rows.push({ id: 'featured', title: 'Featured', icon: 'bookmark', card: 'banner', size: 'large', apps: [featured] });
  if (media.length || !rows.length) rows.push({ id: 'media', title: 'Media', icon: 'media', card: 'banner', size: 'medium', apps: media });
  if (music.length) rows.push({ id: 'music', title: 'Music', icon: 'music', card: 'icon', size: 'medium', apps: music });
  return { ...defaultHome(), rows, hidden: inventory.some((a) => a.package === 'com.android.vending') ? ['com.android.vending'] : [] };
}

export default function HomeScreenTab({ site }: { site: SiteDetail }) {
  const q = useLauncherSite(site.id, 10_000);
  const appsQ = useSiteApps(site);
  const inventory = appsQ.data ?? [];
  const state = q.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<null | 'new' | 'copy' | 'rename' | 'delete' | { switchTo: string }>(null);

  const layouts = state?.layouts ?? [];
  const currentId = selected && layouts.some((l) => l.id === selected) ? selected : state?.layout_id ?? layouts.find((l) => l.site_id === site.id)?.id ?? null;
  const current = layouts.find((l) => l.id === currentId) ?? null;
  const dirty = !!draft && !!current && draft.id === current.id && !sameAs(draft, current);

  useEffect(() => {
    if (!current) { setDraft(null); return; }
    setDraft((d) => (d && d.id === current.id && (d.updated_at === current.updated_at || !sameAs(d, current)) ? d : toDraft(current)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.updated_at]);

  const validation = useMemo(() => (draft ? validateHome(draft.home) : null), [draft]);
  const errors = validation && !validation.ok ? validation.errors : [];
  const accentOk = !draft?.accent || /^#[0-9a-f]{6}$/i.test(draft.accent);
  const welcomeAccent = site.settings.guest.welcome.accent;
  const kiosk = site.settings.guest.kiosk;

  if (q.loading || (q.error && !state)) {
    return q.error ? <Callout kind="crit" title="Couldn’t load the home screen settings">Reload the page to try again.</Callout> : <SkeletonRows rows={8} />;
  }
  if (!state) return null;

  const onBoxes = state.devices.filter((d) => d.layout_id === current?.id && d.launcher?.installed);
  const live = !!current && state.layout_id === current.id;

  const switchTo = (id: string) => {
    if (dirty) setDialog({ switchTo: id });
    else { setSelected(id); setActiveRow(null); }
  };

  const save = async () => {
    if (!draft || !current || !validation?.ok) return;
    setSaving(true);
    const n = onBoxes.length;
    const r = await act(() => api.launcher.update(current.id, { name: draft.name, home: validation.home, accent: draft.accent }), {
      success: n ? `Saved. Sending it to ${n} box${n === 1 ? '' : 'es'} now.` : 'Home screen saved',
      error: 'Couldn’t save the home screen',
    });
    setSaving(false);
    if (r) {
      setQueryData<LauncherSiteState>(launcherSiteKey(site.id), (old) => old && { ...old, layouts: old.layouts.map((l) => (l.id === r.id ? r : l)) });
      setDraft(toDraft(r));
      setTimeout(() => invalidate(launcherSiteKey(site.id)), 2500);
    }
  };

  const setLive = async (id: string | null) => {
    const r = await act(() => api.launcher.setSiteLayout(site.id, id), {
      success: id ? `Sending “${layouts.find((l) => l.id === id)?.name}” to the boxes at ${site.name}` : `Boxes at ${site.name} go back to the classic grid`,
    });
    if (r) invalidate(launcherSiteKey(site.id));
  };

  const siteLayouts = layouts.filter((l) => l.site_id === site.id);
  const templates = layouts.filter((l) => !l.site_id);
  const androids = state.devices.length;

  // ---------------------------------------------------------------- empty state
  if (!current || !draft) {
    const preview = suggestedHome(inventory, kiosk);
    return (
      <div className="space-y-4">
        <Card className="overflow-hidden">
          <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-center lg:p-7">
            <TvPreview home={preview} accent={welcomeAccent} inventory={inventory} kiosk={kiosk} still />
            <div>
              <Badge tone="accent" icon={Sparkles}>Screens Launcher 2</Badge>
              <h2 className="mt-3 text-xl font-semibold text-fg">Design the TV home screen</h2>
              <p className="mt-2 text-sm text-muted">
                A full-screen wallpaper, a big clock and rows of app banners that zoom when selected — set up once here and sent to every Android TV box at {site.name}. Nothing to configure on the TVs.
              </p>
              <ul className="mt-3 space-y-1.5 text-sm text-muted">
                <li className="flex gap-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-ok-fg" aria-hidden />Rows, apps, wallpaper and clock, with a live preview</li>
                <li className="flex gap-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-ok-fg" aria-hidden />Works with your kiosk and welcome settings</li>
                <li className="flex gap-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-ok-fg" aria-hidden />Nothing changes on the TVs until you choose to show it</li>
              </ul>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button variant="primary" size="lg" icon={Plus} onClick={() => setDialog('new')}>Create a home screen</Button>
              </div>
              {androids === 0 && <p className="mt-3 text-xs text-muted">No Android TV boxes here yet. You can still design it now; boxes get it when they’re added.</p>}
            </div>
          </div>
        </Card>
        {androids > 0 && <LauncherRolloutCard siteId={site.id} state={state} />}
        <NewLayoutDialog open={dialog === 'new'} onClose={() => setDialog(null)} site={site} state={state} inventory={inventory} onCreated={(l) => { setSelected(l.id); setDialog(null); }} />
      </div>
    );
  }

  const usedSites = current.used_by?.sites.length ?? 0;
  const menu = [
    { label: 'Rename…', icon: Pencil, onSelect: () => setDialog('rename') },
    { label: 'Duplicate', icon: CopyPlus, onSelect: async () => {
      const r = await act(() => api.launcher.copy(current.id, { site_id: site.id }), { success: 'Duplicated' });
      if (r) { invalidate(launcherSiteKey(site.id)); setSelected(r.id); }
    } },
    { label: 'Copy to another site…', icon: Copy, onSelect: () => setDialog('copy') },
    { label: 'Save as a fleet template', icon: LayoutTemplate, disabled: !current.site_id, onSelect: async () => {
      const r = await act(() => api.launcher.copy(current.id, { site_id: null }), { success: `“${current.name}” is now a fleet template every site can start from` });
      if (r) invalidate(launcherSiteKey(site.id));
    } },
    'sep' as const,
    live
      ? { label: 'Stop showing it (classic grid)', icon: MonitorX, onSelect: () => void setLive(null) }
      : { label: 'Show it on this site’s boxes', icon: MonitorPlay, onSelect: () => void setLive(current.id) },
    { label: 'Delete…', icon: Trash2, danger: true, onSelect: () => setDialog('delete') },
  ];

  return (
    <div className="space-y-4 pb-2">
      {/* layout bar */}
      <Card>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <House className="hidden size-4 text-muted sm:block" aria-hidden />
          <Select aria-label="Layout" value={current.id} onChange={(e) => switchTo(e.target.value)} className="w-full min-w-0 sm:w-72">
            {siteLayouts.length > 0 && <optgroup label={`${site.name}`}>{siteLayouts.map((l) => <option key={l.id} value={l.id}>{l.name}{l.id === state.layout_id ? ' (showing)' : ''}</option>)}</optgroup>}
            {templates.length > 0 && <optgroup label="Fleet templates">{templates.map((l) => <option key={l.id} value={l.id}>{l.name}{l.id === state.layout_id ? ' (showing)' : ''}</option>)}</optgroup>}
          </Select>
          <div className="order-last flex w-full min-w-0 flex-wrap items-center gap-2 sm:order-none sm:w-auto sm:flex-1">
            {live ? (
              <p className="flex items-start gap-1.5 text-xs font-medium text-ok-fg"><MonitorPlay className="mt-px size-3.5 shrink-0" aria-hidden />Showing at {site.name}{onBoxes.length ? ` · ${onBoxes.filter((d) => d.in_sync).length}/${onBoxes.length} boxes up to date` : ''}</p>
            ) : (
              <p className="flex items-start gap-1.5 text-xs font-medium text-muted"><MonitorX className="mt-px size-3.5 shrink-0" aria-hidden />Not showing at {site.name} yet</p>
            )}
            {!current.site_id && <Badge tone="accent" icon={LayoutTemplate}>Fleet template{usedSites ? ` · ${usedSites} site${usedSites === 1 ? '' : 's'}` : ''}</Badge>}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {!live && <Button size="sm" variant="primary" icon={MonitorPlay} disabled={dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => setLive(current.id)}>Show on the boxes</Button>}
            <Button size="sm" icon={Plus} onClick={() => setDialog('new')}>New</Button>
            <Menu trigger={({ toggle, ref }) => <IconButton ref={ref} icon={EllipsisVertical} label="More layout actions" variant="secondary" size="sm" onClick={toggle} />} items={menu} width={250} />
          </div>
        </div>
        {!current.site_id && (
          <div className="border-t border-line px-3 py-2 text-xs text-muted">
            <Info className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />This is a fleet template. Saving it updates every site and box that uses it. To change it for {site.name} only, use “Copy to another site” to make a copy here.
          </div>
        )}
      </Card>

      {/* preview + editor */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 xl:sticky xl:top-[4.5rem] xl:self-start">
          <TvPreview
            home={draft.home}
            accent={draft.accent ?? welcomeAccent}
            inventory={inventory}
            kiosk={kiosk}
            activeRowId={activeRow}
            onActiveRowChange={(id) => {
              setActiveRow(id);
              if (id) document.getElementById(`row-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }}
            footer={
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted">
                <span className="inline-flex items-center gap-1.5"><Keyboard className="size-3.5" aria-hidden />Click the screen, then use the arrow keys like the remote.</span>
                {kiosk.enabled && <span className="inline-flex items-center gap-1.5"><Lock className="size-3.5" aria-hidden />Kiosk mode: only allowed apps show.</span>}
                <span>Banners are look-alikes; the TV shows each app’s real banner.</span>
              </div>
            }
          />
        </div>
        <div className="min-w-0">
          <HomeEditor
            home={draft.home}
            onChange={(home) => setDraft({ ...draft, home })}
            accent={draft.accent}
            onAccentChange={(accent) => setDraft({ ...draft, accent })}
            welcomeAccent={welcomeAccent}
            inventory={inventory}
            activeRowId={activeRow}
            onActiveRowChange={setActiveRow}
            kiosk={kiosk}
          />
        </div>
      </div>

      {/* save bar */}
      {(dirty || errors.length > 0) && (
        <div className="sticky bottom-3 z-20">
          <Card className="shadow-pop">
            <div className="flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1 text-sm">
                {errors.length ? (
                  <p className="text-crit-fg">{errors[0]}{errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}</p>
                ) : !accentOk ? (
                  <p className="text-crit-fg">The accent colour must look like #4F8EF7.</p>
                ) : (
                  <p className="text-fg">Unsaved changes{onBoxes.length ? <span className="text-muted"> · saving sends them to {onBoxes.length} box{onBoxes.length === 1 ? '' : 'es'}</span> : null}</p>
                )}
              </div>
              <Button variant="ghost" icon={Undo2} onClick={() => setDraft(toDraft(current))}>Discard</Button>
              <Button variant="primary" icon={Save} loading={saving} disabled={!dirty || errors.length > 0 || !accentOk} onClick={save}>{onBoxes.length ? 'Save and send to the TVs' : 'Save'}</Button>
            </div>
          </Card>
        </div>
      )}

      <LauncherRolloutCard siteId={site.id} state={state} />

      <NewLayoutDialog open={dialog === 'new'} onClose={() => setDialog(null)} site={site} state={state} inventory={inventory} onCreated={(l) => { setSelected(l.id); setActiveRow(null); setDialog(null); }} />
      <CopyDialog open={dialog === 'copy'} onClose={() => setDialog(null)} layout={current} site={site} />
      <RenameDialog open={dialog === 'rename'} onClose={() => setDialog(null)} name={draft.name} onRename={(name) => setDraft({ ...draft, name })} />
      <ConfirmDialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        danger
        title={`Delete “${current.name}”?`}
        confirmLabel="Delete layout"
        onConfirm={async () => {
          const r = await act(() => api.launcher.remove(current.id), { success: `Deleted “${current.name}”` });
          if (r) { setSelected(null); setDialog(null); invalidate(launcherSiteKey(site.id)); }
        }}
      >
        <p>
          {current.used_by && (current.used_by.sites.length || current.used_by.devices.length)
            ? `It’s in use on ${current.used_by.sites.length ? `${current.used_by.sites.length} site${current.used_by.sites.length === 1 ? '' : 's'}` : ''}${current.used_by.sites.length && current.used_by.devices.length ? ' and ' : ''}${current.used_by.devices.length ? `${current.used_by.devices.length} box${current.used_by.devices.length === 1 ? '' : 'es'}` : ''}. Those boxes go back to the classic grid (or their site’s layout).`
            : 'It isn’t in use anywhere.'}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={typeof dialog === 'object' && dialog !== null}
        onClose={() => setDialog(null)}
        title="Discard your changes?"
        confirmLabel="Discard and switch"
        onConfirm={() => {
          if (typeof dialog === 'object' && dialog) { setDraft(toDraft(current)); setSelected(dialog.switchTo); setActiveRow(null); }
          setDialog(null);
        }}
      >
        <p>You have unsaved changes to “{current.name}”.</p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs

function NewLayoutDialog({ open, onClose, site, state, inventory, onCreated }: {
  open: boolean; onClose: () => void; site: SiteDetail; state: LauncherSiteState; inventory: SiteApp[]; onCreated: (l: LauncherLayout) => void;
}) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState('suggested');
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setName(state.layouts.some((l) => l.site_id === site.id) ? '' : site.name); setFrom('suggested'); setLive(false); }
  }, [open, site.name, site.id, state.layouts]);
  const create = async () => {
    setBusy(true);
    const base = from === 'suggested' ? { home: suggestedHome(inventory, site.settings.guest.kiosk) } : from === 'blank' ? { home: defaultHome() } : { from_id: from };
    const r = await act(() => api.launcher.create({ site_id: site.id, name: name.trim() || 'Home screen', ...base, make_default: live }), {
      success: live ? 'Created and sent to the boxes' : 'Created. Design it, then choose “Show on the boxes”.',
      error: 'Couldn’t create the layout',
    });
    setBusy(false);
    if (r) { invalidate(launcherSiteKey(site.id)); onCreated(r); }
  };
  const opts = [
    { id: 'suggested', label: 'Suggested', hint: 'Featured and Media rows from the apps on this site’s boxes' },
    { id: 'blank', label: 'Empty', hint: 'One empty row' },
    ...state.layouts.map((l) => ({ id: l.id, label: l.site_id ? `Copy of “${l.name}”` : `Template: ${l.name}`, hint: `${l.home.rows.length} row${l.home.rows.length === 1 ? '' : 's'}${l.home.wallpaper ? ', wallpaper' : ''}` })),
  ];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New home screen"
      size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={create}>Create</Button></>}
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="new-layout-name" hint="For you only; guests don’t see it.">
          <Input id="new-layout-name" value={name} maxLength={60} placeholder="e.g. Living room" onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-fg">Start from</legend>
          <div className="space-y-1.5">
            {opts.map((o) => (
              <label key={o.id} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5', from === o.id ? 'border-accent bg-accent-soft/40' : 'border-line hover:bg-surface-2')}>
                <input type="radio" name="layout-from" checked={from === o.id} onChange={() => setFrom(o.id)} className="mt-0.5 accent-accent" />
                <span className="min-w-0"><span className="block text-sm text-fg">{o.label}</span><span className="block text-xs text-muted">{o.hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <Checkbox checked={live} onChange={setLive} label={`Show it on ${site.name}’s boxes straight away`} description="Otherwise nothing changes on the TVs until you choose “Show on the boxes”." />
      </div>
    </Dialog>
  );
}

function CopyDialog({ open, onClose, layout, site }: { open: boolean; onClose: () => void; layout: LauncherLayout; site: SiteDetail }) {
  const sites = useQuery(open ? 'sites' : null, () => api.sites.list());
  const others = (sites.data ?? []).filter((s) => s.id !== site.id);
  const [to, setTo] = useState('');
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setTo(''); setLive(false); } }, [open]);
  const target = others.find((s) => s.id === to);
  const copy = async () => {
    if (!target) return;
    setBusy(true);
    const r = await act(() => api.launcher.copy(layout.id, { site_id: target.id, make_default: live }), { success: `Copied “${layout.name}” to ${target.name}${live ? ' and sent it to its boxes' : ''}`, error: 'Couldn’t copy the layout' });
    setBusy(false);
    if (r) { invalidate(launcherSiteKey(target.id)); onClose(); }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Copy “${layout.name}” to another site`}
      description="The copy is independent: changing it later doesn’t change this one."
      size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={Copy} loading={busy} disabled={!target} onClick={copy}>Copy</Button></>}
    >
      <div className="space-y-4">
        <Field label="Site" htmlFor="copy-site">
          <Select id="copy-site" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{sites.loading ? 'Loading…' : 'Choose a site'}</option>
            {others.map((s) => <option key={s.id} value={s.id}>{s.name}{s.client_name ? ` (${s.client_name})` : ''}</option>)}
          </Select>
        </Field>
        <Checkbox checked={live} onChange={setLive} label="Show it on that site’s boxes now" />
      </div>
    </Dialog>
  );
}

function RenameDialog({ open, onClose, name, onRename }: { open: boolean; onClose: () => void; name: string; onRename: (n: string) => void }) {
  const [v, setV] = useState(name);
  useEffect(() => { if (open) setV(name); }, [open, name]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rename layout"
      size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v.trim()} onClick={() => { onRename(v.trim()); onClose(); }}>Rename</Button></>}
    >
      <Field label="Name" htmlFor="rename-layout" hint="Saved with your other changes.">
        <Input id="rename-layout" value={v} maxLength={60} onChange={(e) => setV(e.target.value)} autoFocus />
      </Field>
    </Dialog>
  );
}
