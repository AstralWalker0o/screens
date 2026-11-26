import { useRef, useState, type DragEvent } from 'react';
import { useParams } from 'react-router';
import { Package, ShieldCheck, Upload, Trash2, FileBox, Plus, Pencil, Ellipsis, Ban, Download, LayoutGrid, X } from 'lucide-react';
import type { Apk, AppPolicy } from '../../shared/types';
import { api } from '../api';
import { act, setQueryData, useQuery } from '../lib/query';
import { fmtBytes, truncateMiddle } from '../lib/format';
import { AppIcon } from '../components/AppLauncher';
import { Badge, Button, Callout, Card, CardBody, CopyButton, EmptyState, IconButton, PageHeader, RelTime, SkeletonRows, TabNav, TableWrap, cn, td, th } from '../components/ui';
import { ChipsInput, Field, Input, Segmented, Select, Toggle, isPackage } from '../components/forms';
import { ConfirmDialog, Dialog, Menu } from '../components/overlay';

export default function Library() {
  const { tab = 'apks' } = useParams();
  return (
    <>
      <PageHeader title="Library" subtitle="Android apps you can install on any box, and rules for which apps should or shouldn’t be there." />
      <TabNav base="/library" active={tab} tabs={[{ id: 'apks', label: 'APKs', icon: Package }, { id: 'policies', label: 'App policies', icon: ShieldCheck }]} />
      {tab === 'policies' ? <PoliciesTab /> : <ApksTab />}
    </>
  );
}

// ---------------------------------------------------------------------------

function ApksTab() {
  const q = useQuery('apks', api.apks.list);
  const [drag, setDrag] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState({ label: '', package: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<Apk | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    if (!/\.apk$/i.test(f.name)) {
      act(() => Promise.reject(new Error('That file isn’t an APK. Android app files end in .apk.')), { error: 'Can’t upload that file' });
      return;
    }
    setFile(f);
    setMeta({ label: f.name.replace(/\.apk$/i, '').replace(/[-_]+/g, ' ').replace(/\s*v?\d+(\.\d+)+.*$/, ''), package: '', notes: '' });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files?.[0]);
  };
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    const r = await act(() => api.apks.upload(file, { label: meta.label.trim() || undefined, package: meta.package.trim() || undefined, notes: meta.notes.trim() || undefined }), {
      success: (a) => `Uploaded ${a.label ?? file.name}. You can now install it from any Android device’s Apps tab.`,
    });
    setBusy(false);
    if (r) {
      setQueryData<Apk[]>('apks', (old) => [r, ...(old ?? [])]);
      setFile(null);
    }
  };

  return (
    <div className="space-y-4">
      {!file ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          className={cn('flex flex-col items-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors', drag ? 'border-accent bg-accent-soft/60' : 'border-line-strong bg-surface/50')}
        >
          <Upload className={cn('size-6', drag ? 'text-accent-fg' : 'text-muted')} aria-hidden />
          <p className="mt-2 text-sm font-medium text-fg">Drop an .apk file here</p>
          <p className="mt-0.5 text-sm text-muted">or</p>
          <Button className="mt-2" icon={FileBox} onClick={() => input.current?.click()}>Choose a file</Button>
          <input ref={input} type="file" accept=".apk,application/vnd.android.package-archive" className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} aria-label="Choose an APK file" />
          <p className="mt-3 max-w-md text-xs text-muted">Only upload apps you trust, from the developer’s own site or a reputable mirror. Screens checks the file hasn’t changed before installing it.</p>
        </div>
      ) : (
        <Card>
          <CardBody className="space-y-4 pt-4">
            <div className="flex items-center gap-3">
              <FileBox className="size-8 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">{file.name}</p>
                <p className="text-xs text-muted">{fmtBytes(file.size)}</p>
              </div>
              <IconButton icon={X} label="Choose a different file" onClick={() => setFile(null)} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="apk-label"><Input id="apk-label" value={meta.label} onChange={(e) => setMeta({ ...meta, label: e.target.value })} /></Field>
              <Field label="Package name" htmlFor="apk-pkg" optional hint="Read from the file if left blank."><Input id="apk-pkg" mono value={meta.package} onChange={(e) => setMeta({ ...meta, package: e.target.value })} placeholder="org.example.app" /></Field>
            </div>
            <Field label="Notes" htmlFor="apk-notes" optional><Input id="apk-notes" value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} placeholder="Where it came from, why it’s here" /></Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setFile(null)}>Cancel</Button>
              <Button variant="primary" icon={Upload} loading={busy} onClick={upload}>{busy ? 'Uploading…' : 'Upload'}</Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        {q.loading ? (
          <div className="p-4"><SkeletonRows rows={4} /></div>
        ) : !q.data?.length ? (
          <EmptyState icon={Package} title="No apps in the library yet">Upload an APK above. You can then install it on any Android TV box from its Apps tab, or require it with an app policy.</EmptyState>
        ) : (
          <>
            <TableWrap className="hidden md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-2/60">
                  <tr><th className={th}>App</th><th className={th}>Version</th><th className={cn(th, 'text-right')}>Size</th><th className={cn(th, 'hidden lg:table-cell')}>Checksum</th><th className={th}>Uploaded</th><th className={cn(th, 'w-10')}><span className="sr-only">Delete</span></th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {q.data.map((a) => (
                    <tr key={a.id}>
                      <td className={td}>
                        <div className="flex items-center gap-2.5">
                          <AppIcon app={{ label: a.label, package: a.package ?? a.id }} size="sm" />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-fg">{a.label ?? a.package ?? 'Unnamed app'}</p>
                            <p className="truncate font-mono text-[11.5px] text-muted">{a.package ?? '–'}</p>
                            {a.notes && <p className="truncate text-xs text-muted">{a.notes}</p>}
                          </div>
                        </div>
                      </td>
                      <td className={cn(td, 'tnum')}>{a.version_name ?? '–'}</td>
                      <td className={cn(td, 'text-right whitespace-nowrap tnum')}>{fmtBytes(a.size)}</td>
                      <td className={cn(td, 'hidden lg:table-cell')}><span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted" title={a.sha256}>{truncateMiddle(a.sha256, 16)}<CopyButton text={a.sha256} label="" size="xs" variant="ghost" /></span></td>
                      <td className={cn(td, 'text-xs whitespace-nowrap text-muted')}><RelTime ts={a.uploaded_at} /></td>
                      <td className={td}><IconButton icon={Trash2} label={`Delete ${a.label ?? a.package}`} size="sm" variant="danger-ghost" onClick={() => setDel(a)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <ul className="divide-y divide-line md:hidden">
              {q.data.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                  <AppIcon app={{ label: a.label, package: a.package ?? a.id }} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{a.label ?? a.package}</p>
                    <p className="truncate text-xs text-muted">{a.version_name ? `v${a.version_name} · ` : ''}{fmtBytes(a.size)} · <RelTime ts={a.uploaded_at} /></p>
                  </div>
                  <IconButton icon={Trash2} label={`Delete ${a.label ?? a.package}`} size="sm" variant="danger-ghost" onClick={() => setDel(a)} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        danger
        title={`Delete ${del?.label ?? 'this app'}?`}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!del) return;
          const ok = await act(() => api.apks.remove(del.id), { success: 'Deleted from the library' });
          if (ok) {
            setQueryData<Apk[]>('apks', (old) => old?.filter((x) => x.id !== del.id));
            setDel(null);
          }
        }}
      >
        <p>Devices that already have it keep it. App policies that install it from the library will fall back to the Play Store.</p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PoliciesTab() {
  const q = useQuery('app-policies', api.appPolicies.list);
  const sites = useQuery('sites', () => api.sites.list());
  const clients = useQuery('clients', api.clients.list);
  const devices = useQuery('devices', () => api.devices.list());
  const apks = useQuery('apks', api.apks.list);
  const [edit, setEdit] = useState<AppPolicy | 'new' | null>(null);
  const [del, setDel] = useState<AppPolicy | null>(null);

  const scopeName = (p: AppPolicy) =>
    p.scope_type === 'global' ? 'Every Android box'
      : p.scope_type === 'site' ? sites.data?.find((s) => s.id === p.scope_id)?.name ?? 'a site'
        : p.scope_type === 'client' ? `All of ${clients.data?.find((c) => c.id === p.scope_id)?.name ?? 'a client'}`
          : devices.data?.find((d) => d.id === p.scope_id)?.name ?? 'a device';
  const toggle = async (p: AppPolicy, enabled: boolean) => {
    setQueryData<AppPolicy[]>('app-policies', (old) => old?.map((x) => (x.id === p.id ? { ...x, enabled } : x)));
    await act(() => api.appPolicies.update(p.id, { enabled }), { invalidate: ['app-policies'] });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Callout kind="info" className="max-w-3xl flex-1">
          App policies keep Android boxes the way you want them. <strong className="text-fg">Required</strong> apps are installed automatically (from your library, or the Play Store).
          <strong className="text-fg"> Banned</strong> apps are disabled or removed when they show up. <strong className="text-fg">Kiosk</strong> limits a box to a short list of apps. Policies apply when an automation runs “Apply app policies”, or after a guest reset.
        </Callout>
        <Button variant="primary" icon={Plus} onClick={() => setEdit('new')}>New policy</Button>
      </div>
      {q.loading ? (
        <SkeletonRows rows={4} />
      ) : !q.data?.length ? (
        <Card><EmptyState icon={ShieldCheck} title="No app policies" action={<Button variant="primary" icon={Plus} onClick={() => setEdit('new')}>New policy</Button>}>For example: make sure every rental box has Netflix and Stan, and never has ad-funded players.</EmptyState></Card>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {q.data.map((p) => (
            <li key={p.id}>
              <Card className={cn('h-full p-4', !p.enabled && 'opacity-75')}>
                <div className="flex items-start gap-3">
                  <Toggle checked={p.enabled} onChange={(v) => toggle(p, v)} ariaLabel={`${p.enabled ? 'Turn off' : 'Turn on'} ${p.name}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-fg">{p.name}</p>
                    <p className="text-xs text-muted">Applies to: {scopeName(p)}</p>
                  </div>
                  <Menu
                    trigger={({ toggle: t, ref }) => <IconButton ref={ref} icon={Ellipsis} label={`More actions for ${p.name}`} onClick={t} size="sm" />}
                    items={[{ label: 'Edit', icon: Pencil, onSelect: () => setEdit(p) }, { label: 'Delete…', icon: Trash2, danger: true, onSelect: () => setDel(p) }]}
                  />
                </div>
                <dl className="mt-3 space-y-2.5 text-sm">
                  <div>
                    <dt className="flex items-center gap-1.5 text-xs font-medium text-muted"><Download className="size-3.5" aria-hidden />Required</dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {p.required.length ? p.required.map((r) => (
                        <Badge key={r.package} mono title={r.apk_id ? 'Installed from your library' : 'Installed from the Play Store'}>{r.package}{r.apk_id ? ' · library' : ''}</Badge>
                      )) : <span className="text-xs text-subtle">None</span>}
                    </dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1.5 text-xs font-medium text-muted"><Ban className="size-3.5" aria-hidden />Banned — {p.ban_action === 'uninstall' ? 'uninstalled' : 'disabled'}</dt>
                    <dd className="mt-1 flex flex-wrap gap-1">{p.banned.length ? p.banned.map((b) => <Badge key={b} tone="crit" mono>{b}</Badge>) : <span className="text-xs text-subtle">None</span>}</dd>
                  </div>
                  {p.kiosk_allowed?.length ? (
                    <div>
                      <dt className="flex items-center gap-1.5 text-xs font-medium text-muted"><LayoutGrid className="size-3.5" aria-hidden />Kiosk — only these apps can open</dt>
                      <dd className="mt-1 flex flex-wrap gap-1">{p.kiosk_allowed.map((k) => <Badge key={k} tone="accent" mono>{k}</Badge>)}</dd>
                    </div>
                  ) : null}
                </dl>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <PolicyDialog
        policy={edit}
        onClose={() => setEdit(null)}
        sites={sites.data ?? []}
        clients={clients.data ?? []}
        devices={(devices.data ?? []).filter((d) => d.kind === 'android')}
        apks={apks.data ?? []}
      />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        danger
        title={`Delete “${del?.name}”?`}
        confirmLabel="Delete policy"
        onConfirm={async () => {
          if (!del) return;
          const ok = await act(() => api.appPolicies.remove(del.id), { success: 'Policy deleted', invalidate: ['app-policies'] });
          if (ok) setDel(null);
        }}
      >
        <p>Apps it installed stay installed, and banned apps stay disabled until you change them on the device.</p>
      </ConfirmDialog>
    </div>
  );
}

type PolicyForm = Omit<AppPolicy, 'id' | 'created_at'>;
const emptyPolicy = (): PolicyForm => ({ name: '', scope_type: 'global', scope_id: null, required: [], banned: [], ban_action: 'disable', kiosk_allowed: null, enabled: true });

function PolicyDialog({ policy, onClose, sites, clients, devices, apks }: {
  policy: AppPolicy | 'new' | null; onClose: () => void; sites: { id: string; name: string }[]; clients: { id: string; name: string }[]; devices: { id: string; name: string; site_name?: string }[]; apks: Apk[];
}) {
  const [f, setF] = useState<PolicyForm>(emptyPolicy());
  const [seed, setSeed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newReq, setNewReq] = useState('');
  const key = policy === 'new' ? 'new' : policy?.id ?? null;
  if (key && seed !== key) {
    setSeed(key);
    setF(policy && policy !== 'new' ? { name: policy.name, scope_type: policy.scope_type, scope_id: policy.scope_id ?? null, required: policy.required, banned: policy.banned, ban_action: policy.ban_action, kiosk_allowed: policy.kiosk_allowed ?? null, enabled: policy.enabled } : emptyPolicy());
  }
  if (!key && seed) setSeed(null);
  const valid = f.name.trim() && (f.scope_type === 'global' || f.scope_id);
  const scopeOptions = f.scope_type === 'site' ? sites : f.scope_type === 'client' ? clients : f.scope_type === 'device' ? devices.map((d) => ({ id: d.id, name: `${d.name}${d.site_name ? ` (${d.site_name})` : ''}` })) : [];

  const save = async () => {
    setBusy(true);
    const body = { ...f, name: f.name.trim(), scope_id: f.scope_type === 'global' ? null : f.scope_id };
    const r = policy === 'new'
      ? await act(() => api.appPolicies.create(body), { success: `Created “${body.name}”`, invalidate: ['app-policies'] })
      : await act(() => api.appPolicies.update((policy as AppPolicy).id, body), { success: 'Policy saved', invalidate: ['app-policies'] });
    setBusy(false);
    if (r) onClose();
  };

  const addRequired = (pkg: string) => {
    const p = pkg.trim();
    if (!p || isPackage(p) || f.required.some((r) => r.package === p)) return;
    const apk = apks.find((a) => a.package === p);
    setF({ ...f, required: [...f.required, { package: p, apk_id: apk?.id ?? null }] });
    setNewReq('');
  };

  return (
    <Dialog
      open={!!policy}
      onClose={onClose}
      size="lg"
      title={policy === 'new' ? 'New app policy' : 'Edit app policy'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={save}>{policy === 'new' ? 'Create policy' : 'Save'}</Button></>}
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="pol-name"><Input id="pol-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Rental basics" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Applies to" htmlFor="pol-scope">
              <Select id="pol-scope" value={f.scope_type} onChange={(e) => setF({ ...f, scope_type: e.target.value as PolicyForm['scope_type'], scope_id: null })}>
                <option value="global">Everything</option>
                <option value="client">A client</option>
                <option value="site">A site</option>
                <option value="device">A device</option>
              </Select>
            </Field>
            {f.scope_type !== 'global' && (
              <Field label="Which" htmlFor="pol-scope-id">
                <Select id="pol-scope-id" value={f.scope_id ?? ''} onChange={(e) => setF({ ...f, scope_id: e.target.value || null })}>
                  <option value="">Choose…</option>
                  {scopeOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              </Field>
            )}
          </div>
        </div>

        <Field label="Required apps" hint="Installed automatically when missing. Apps in your library are installed from there; others open the Play Store.">
          <ul className="mb-2 space-y-1">
            {f.required.map((r) => (
              <li key={r.package} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{r.package}</span>
                <Select aria-label={`Source for ${r.package}`} value={r.apk_id ?? ''} onChange={(e) => setF({ ...f, required: f.required.map((x) => (x.package === r.package ? { ...x, apk_id: e.target.value || null } : x)) })} className="w-48">
                  <option value="">Play Store</option>
                  {apks.map((a) => <option key={a.id} value={a.id}>Library: {a.label ?? a.package} {a.version_name ?? ''}</option>)}
                </Select>
                <IconButton icon={X} label={`Remove ${r.package}`} size="sm" onClick={() => setF({ ...f, required: f.required.filter((x) => x.package !== r.package) })} />
              </li>
            ))}
          </ul>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addRequired(newReq); }}>
            <Input mono value={newReq} onChange={(e) => setNewReq(e.target.value)} placeholder="com.netflix.ninja" aria-label="Add a required app" list="pol-apks" />
            <datalist id="pol-apks">{apks.filter((a) => a.package).map((a) => <option key={a.id} value={a.package!}>{a.label}</option>)}</datalist>
            <Button type="submit" icon={Plus} disabled={!newReq.trim() || !!isPackage(newReq.trim())}>Add</Button>
          </form>
        </Field>

        <Field label="Banned apps">
          <ChipsInput value={f.banned} onChange={(banned) => setF({ ...f, banned })} mono validate={isPackage} placeholder="com.example.adware" ariaLabel="Banned apps" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">When found:</span>
            <Segmented<'disable' | 'uninstall'> ariaLabel="What to do with banned apps" size="sm" value={f.ban_action} onChange={(ban_action) => setF({ ...f, ban_action })} options={[{ value: 'disable', label: 'Disable it' }, { value: 'uninstall', label: 'Uninstall it' }]} />
          </div>
          <p className="mt-1 text-xs text-muted">Disabling hides the app and stops it running, and is easy to undo. System apps can only be disabled.</p>
        </Field>

        <div className="rounded-lg border border-line p-3">
          <Toggle
            checked={f.kiosk_allowed != null}
            onChange={(v) => setF({ ...f, kiosk_allowed: v ? f.required.map((r) => r.package) : null })}
            label="Kiosk: only allow these apps to open"
            description="Any other app is closed as soon as it opens. Good for lobby screens. For rentals, the Screens Launcher’s kiosk mode (site → Guest) is friendlier."
          />
          {f.kiosk_allowed != null && (
            <div className="mt-3"><ChipsInput value={f.kiosk_allowed} onChange={(kiosk_allowed) => setF({ ...f, kiosk_allowed })} mono validate={isPackage} placeholder="com.google.android.youtube.tv" ariaLabel="Kiosk allowed apps" /></div>
          )}
        </div>
        <Toggle checked={f.enabled} onChange={(enabled) => setF({ ...f, enabled })} label="Policy is on" />
      </div>
    </Dialog>
  );
}
