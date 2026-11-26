import { useState } from 'react';
import { Link } from 'react-router';
import { CloudDownload, KeyRound, Library, Trash2 } from 'lucide-react';
import type { UpdateMode, UpdatePackage, UpdatesOverview } from '../../../shared/updates';
import { versionText } from '../../../shared/updates';
import { api } from '../../api';
import { act } from '../../lib/query';
import { fmtBytes } from '../../lib/format';
import { Field, Input, Segmented, Select, Toggle } from '../../components/forms';
import { Dialog } from '../../components/overlay';
import { Badge, Button, Callout, RelTime, SectionLabel, cn } from '../../components/ui';
import { abiText, checkMessage, MODE } from './meta';

type SourceKind = 'library' | 'github';
interface Form {
  kind: SourceKind; repo: string; asset_pattern: string; arm64: string; armv7: string; include_prereleases: boolean; enabled: boolean;
  fleet: UpdateMode; sites: Record<string, UpdateMode | ''>;
}

function seed(p: UpdatePackage): Form {
  return {
    kind: p.source ? 'github' : 'library',
    repo: p.source?.repo ?? '', asset_pattern: p.source?.asset_pattern ?? '*.apk',
    arm64: p.source?.abi_patterns['arm64-v8a'] ?? '', armv7: p.source?.abi_patterns['armeabi-v7a'] ?? '',
    include_prereleases: p.source?.include_prereleases ?? false, enabled: p.source?.enabled ?? true,
    fleet: p.fleet_mode ?? 'notify', sites: { ...p.site_modes },
  };
}

const MODE_OPTS = (['auto', 'notify', 'pin'] as UpdateMode[]).map((m) => ({ value: m, label: MODE[m].label, icon: MODE[m].icon, title: MODE[m].help }));

export function PackageDialog({ pkg, sites, onClose }: { pkg: UpdatePackage | null; sites: UpdatesOverview['sites']; onClose: () => void }) {
  const [f, setF] = useState<Form | null>(null);
  const [seeded, setSeeded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (pkg && seeded !== pkg.package) { setSeeded(pkg.package); setF(seed(pkg)); }
  if (!pkg && seeded) { setSeeded(null); setF(null); }
  const p = pkg;
  const form = f;
  const siteIds = p ? [...new Set([...p.boxes.map((b) => b.site_id), ...Object.keys(p.site_modes)])] : [];
  const repoOk = !form || form.kind === 'library' || /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(form.repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, ''));

  const save = async () => {
    if (!p || !form) return;
    setBusy('save');
    const ops: Promise<unknown>[] = [];
    if (form.fleet !== (p.fleet_mode ?? 'notify')) ops.push(api.updates.setPolicy({ package: p.package, scope_type: 'fleet', mode: form.fleet }));
    for (const id of siteIds) {
      const want = form.sites[id] || null, had = p.site_modes[id] ?? null;
      if (want !== had) ops.push(api.updates.setPolicy({ package: p.package, scope_type: 'site', scope_id: id, mode: want }));
    }
    const abi: Record<string, string> = {};
    if (form.arm64.trim()) abi['arm64-v8a'] = form.arm64.trim();
    if (form.armv7.trim()) abi['armeabi-v7a'] = form.armv7.trim();
    const src = p.source;
    const changed = form.kind === 'github' && (!src || src.repo !== form.repo.trim() || src.asset_pattern !== form.asset_pattern.trim() || JSON.stringify(src.abi_patterns) !== JSON.stringify(abi)
      || src.include_prereleases !== form.include_prereleases || src.enabled !== form.enabled);
    const ok = await act(async () => {
      await Promise.all(ops);
      if (form.kind === 'library' && src) await api.updates.removeSource(p.package);
      if (changed) return api.updates.saveSource({ package: p.package, repo: form.repo.trim(), asset_pattern: form.asset_pattern.trim() || '*.apk', abi_patterns: abi, include_prereleases: form.include_prereleases, enabled: form.enabled });
      return null;
    }, {
      success: (r) => (r?.check ? `Saved. ${checkMessage([r.check])}` : 'Saved'),
      error: 'Couldn’t save',
      invalidate: ['updates'],
    });
    setBusy(null);
    if (ok !== undefined) onClose();
  };

  const checkNow = async () => {
    if (!p) return;
    setBusy('check');
    await act(() => api.updates.check(p.package), { success: (r) => checkMessage(r.results), invalidate: ['updates'] });
    setBusy(null);
  };
  const forgetKey = async () => {
    if (!p) return;
    setBusy('key');
    await act(() => api.updates.updateSource(p.package, { reset_signer: true }), { success: 'Screens will trust the signing key of the next release it downloads.', invalidate: ['updates'] });
    setBusy(null);
  };

  return (
    <Dialog
      open={!!p}
      onClose={onClose}
      size="lg"
      title={p ? `${p.label}: updates` : ''}
      description={p ? <span className="font-mono text-xs">{p.package}</span> : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 'save'} disabled={!repoOk} onClick={save}>Save</Button></>}
    >
      {p && form && (
        <div className="space-y-6">
          <section>
            <SectionLabel>Where updates come from</SectionLabel>
            {p.builtin ? (
              <Callout kind="tip">The Screens Launcher is built in: new versions are published to the library with each Screens release.</Callout>
            ) : (
              <>
                <Segmented<SourceKind>
                  ariaLabel="Update source"
                  value={form.kind}
                  onChange={(kind) => setF({ ...form, kind })}
                  options={[{ value: 'library', label: 'Library uploads', icon: Library }, { value: 'github', label: 'GitHub releases', icon: CloudDownload }]}
                />
                {form.kind === 'library' ? (
                  <p className="mt-2 text-sm text-muted">The newest APK for this app in the <Link to="/library/apks" className="font-medium text-accent-fg hover:underline">Library</Link> is the update. Upload a new version there.</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    <Field label="Repository" htmlFor="src-repo" hint="owner/name from the GitHub address, e.g. jellyfin/jellyfin-androidtv" error={repoOk ? undefined : 'Use the form owner/name'}>
                      <Input id="src-repo" mono value={form.repo} onChange={(e) => setF({ ...form, repo: e.target.value })} placeholder="yuliskov/SmartTube" />
                    </Field>
                    <Field label="APK file name" htmlFor="src-pattern" hint="* matches anything. Used for boxes without a more specific pattern below.">
                      <Input id="src-pattern" mono value={form.asset_pattern} onChange={(e) => setF({ ...form, asset_pattern: e.target.value })} placeholder="*.apk" />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="For 64-bit boxes" htmlFor="src-arm64" optional hint="arm64-v8a, e.g. *arm64*.apk">
                        <Input id="src-arm64" mono value={form.arm64} onChange={(e) => setF({ ...form, arm64: e.target.value })} placeholder="*arm64*.apk" />
                      </Field>
                      <Field label="For 32-bit boxes" htmlFor="src-armv7" optional hint="armeabi-v7a, e.g. *armeabi-v7a*.apk">
                        <Input id="src-armv7" mono value={form.armv7} onChange={(e) => setF({ ...form, armv7: e.target.value })} placeholder="*armeabi-v7a*.apk" />
                      </Field>
                    </div>
                    <Toggle checked={form.include_prereleases} onChange={(include_prereleases) => setF({ ...form, include_prereleases })} label="Include pre-releases (betas)" />
                    {p.source && (
                      <div className="rounded-lg border border-line bg-surface-2/50 p-3 text-sm">
                        <p className="text-muted">
                          Checked <RelTime ts={p.source.last_checked} />
                          {p.source.latest_tag && <> · latest release <span className="font-mono text-fg">{p.source.latest_tag}</span></>}
                          {p.source.last_status === 'not_modified' && ' · no change'}
                        </p>
                        {p.source.last_error && <p className={cn('mt-1', p.source.last_status === 'rate_limited' ? 'text-warn-fg' : 'text-crit-fg')}>{p.source.last_error}</p>}
                        {p.source.signer_sha256 && (
                          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted" title={p.source.signer_sha256}>
                            <KeyRound className="size-3.5" aria-hidden />Trusted signing key <span className="font-mono">{p.source.signer_sha256.slice(0, 16)}…</span>
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button size="sm" icon={CloudDownload} loading={busy === 'check'} onClick={checkNow}>Check now</Button>
                          {p.source.signer_sha256 && /different key/i.test(p.source.last_error ?? '') && (
                            <Button size="sm" icon={KeyRound} loading={busy === 'key'} onClick={forgetKey} title="Only if the developer announced a new signing key">Trust the new key</Button>
                          )}
                        </div>
                      </div>
                    )}
                    <p className="text-xs text-muted">Screens checks every 6 hours, downloads matching APKs into the library, and only accepts them if they are this app and signed by the same developer key as before.</p>
                  </div>
                )}
              </>
            )}
          </section>

          <section>
            <SectionLabel>What to do with updates</SectionLabel>
            <Field label="Every site" hint={MODE[form.fleet].help}>
              <Segmented<UpdateMode> ariaLabel="Policy for every site" value={form.fleet} onChange={(fleet) => setF({ ...form, fleet })} options={MODE_OPTS} />
            </Field>
            {siteIds.length > 0 && (
              <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
                {siteIds.map((id) => {
                  const s = sites.find((x) => x.site_id === id);
                  return (
                    <li key={id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{s?.site_name ?? id}</span>
                      <Select aria-label={`Policy at ${s?.site_name ?? id}`} value={form.sites[id] ?? ''} onChange={(e) => setF({ ...form, sites: { ...form.sites, [id]: e.target.value as UpdateMode | '' } })} className="w-48">
                        <option value="">Default ({MODE[form.fleet].label})</option>
                        <option value="auto">Auto</option>
                        <option value="notify">Notify</option>
                        <option value="pin">Pin</option>
                      </Select>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted">Screens never downgrades an app, never uninstalls one to update it, and leaves apps from Google Play to Play.</p>
          </section>

          <section>
            <SectionLabel>Builds Screens has</SectionLabel>
            {p.versions.length === 0 ? (
              <p className="text-sm text-muted">None yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {p.versions.map((v) => (
                  <li key={v.apk_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="font-medium text-fg tnum">{versionText(v)}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted" title={v.abis.join(', ')}>{v.abis.length === 0 ? 'Any processor' : v.abis.length > 2 ? 'Universal' : v.abis.map((a) => abiText(a)).join(', ')}</span>
                    <Badge>{v.source === 'github' ? `GitHub${v.tag ? ` ${v.tag}` : ''}` : 'Uploaded'}</Badge>
                    <span className="text-xs text-muted tnum">{fmtBytes(v.size)} · <RelTime ts={v.uploaded_at} /></span>
                  </li>
                ))}
              </ul>
            )}
            {p.versions.length > 0 && !p.builtin && (
              <p className="mt-2 text-xs text-muted">Remove builds from the <Link to="/library/apks" className="font-medium text-accent-fg hover:underline">Library</Link>. <Trash2 className="inline size-3" aria-hidden /></p>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
