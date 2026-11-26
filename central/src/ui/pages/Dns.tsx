import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Globe, ListFilter, ListChecks, Ban, Check, Plus, Trash2, RefreshCw, TriangleAlert, ExternalLink, Hammer, ShieldCheck } from 'lucide-react';
import type { DnsCategory, DnsDomainStat, DnsList, DnsPolicyName, DnsRule } from '../../shared/types';
import { api } from '../api';
import { act, setQueryData, useQuery } from '../lib/query';
import { useDebounced } from '../lib/hooks';
import { fmtCompact, fmtNum, truncateMiddle } from '../lib/format';
import { CATEGORY, CATEGORY_ORDER, POLICIES, POLICY } from '../lib/labels';
import { Badge, Button, Callout, Card, CardBody, CardHeader, EmptyState, IconButton, PageHeader, RelTime, SkeletonRows, TabNav, TableWrap, cn, td, th } from '../components/ui';
import { Checkbox, Field, Input, SearchInput, Segmented, Select, Textarea, Toggle, isDomain } from '../components/forms';
import { ConfirmDialog, Dialog } from '../components/overlay';
import { CategoryBadge } from '../components/status';

export default function Dns() {
  const { tab = 'domains' } = useParams();
  return (
    <>
      <PageHeader title="DNS" subtitle="Every device lookup passes through your gateways. Here you decide what gets blocked." />
      <TabNav
        base="/dns"
        active={tab}
        tabs={[
          { id: 'domains', label: 'Domains', icon: Globe },
          { id: 'rules', label: 'Rules', icon: ListFilter },
          { id: 'blocklists', label: 'Blocklists', icon: ListChecks },
        ]}
      />
      {tab === 'rules' ? <RulesTab /> : tab === 'blocklists' ? <ListsTab /> : <DomainsTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Domains

function DomainsTab() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebounced(text.trim(), 300);
  const cat = params.get('category') ?? '';
  const site = params.get('site') ?? '';
  const days = Number(params.get('days') ?? 7);
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const sites = useQuery('sites', () => api.sites.list());
  const key = `dns-domains:${q}|${cat}|${site}|${days}`;
  const res = useQuery(key, () => api.dns.domains({ q: q || undefined, category: cat || undefined, site_id: site || undefined, days, limit: 200 }));
  const [busy, setBusy] = useState<string | null>(null);

  const rule = async (d: DnsDomainStat, action: 'block' | 'allow') => {
    setBusy(`${d.domain}:${action}`);
    const r = await act(
      () => api.dns.addRule({ domain: d.domain, action, category: d.category ?? null, vendor: d.vendor ?? null, policies: action === 'block' ? ['balanced', 'strict'] : ['balanced', 'strict', 'monitor'], scope_type: site ? 'site' : 'global', scope_id: site || '', notes: null }),
      { success: `${action === 'block' ? 'Blocking' : 'Allowing'} ${d.domain}${site ? ' at this site' : ' everywhere'}. Gateways update within a minute.`, invalidate: ['rules', 'privacy'] },
    );
    setBusy(null);
    if (r) setQueryData<DnsDomainStat[]>(key, (old) => old?.map((x) => (x.domain === d.domain ? { ...x, rule: action } : x)));
  };

  const list = res.data ?? [];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={text} onChange={(v) => { setText(v); set('q', v.trim()); }} placeholder="Search domains or vendors" className="w-full sm:w-72" />
        <Select aria-label="Category" value={cat} onChange={(e) => set('category', e.target.value)} className="w-[calc(50%-4px)] sm:w-44">
          <option value="">All categories</option>
          {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY[c].label}</option>)}
        </Select>
        <Select aria-label="Site" value={site} onChange={(e) => set('site', e.target.value)} className="w-[calc(50%-4px)] sm:w-44">
          <option value="">All sites</option>
          {(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Segmented<string> ariaLabel="Time range" size="sm" value={String(days)} onChange={(v) => set('days', v === '7' ? '' : v)} options={[{ value: '1', label: '24 h' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} />
      </div>
      <Card>
        {res.loading ? (
          <div className="p-4"><SkeletonRows rows={8} /></div>
        ) : list.length === 0 ? (
          <EmptyState icon={Globe} title="No domains match">{q || cat ? 'Try a shorter search or another category.' : 'Domains appear here once devices start making lookups through a gateway.'}</EmptyState>
        ) : (
          <>
            <TableWrap className="hidden md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-2/60">
                  <tr>
                    <th className={th}>Domain</th><th className={th}>Category</th><th className={cn(th, 'hidden lg:table-cell')}>Vendor</th>
                    <th className={cn(th, 'text-right')}>Lookups</th><th className={cn(th, 'text-right')}>Blocked</th><th className={cn(th, 'hidden text-right xl:table-cell')}>Would block</th>
                    <th className={cn(th, 'hidden text-right lg:table-cell')}>Devices</th><th className={cn(th, 'hidden xl:table-cell')}>Last seen</th><th className={cn(th, 'text-right')}>Rule</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.map((d) => (
                    <tr key={d.domain} className="hover:bg-surface-2/50">
                      <td className={cn(td, 'max-w-80 truncate font-mono text-[12.5px] text-fg')} title={d.domain}>{d.domain}</td>
                      <td className={td}><CategoryBadge cat={d.category} /></td>
                      <td className={cn(td, 'hidden text-muted lg:table-cell')}>{d.vendor ?? '–'}</td>
                      <td className={cn(td, 'text-right tnum')}>{fmtNum(d.queries)}</td>
                      <td className={cn(td, 'text-right tnum', d.blocked ? 'text-crit-fg' : 'text-subtle')}>{d.blocked ? fmtCompact(d.blocked) : '–'}</td>
                      <td className={cn(td, 'hidden text-right tnum xl:table-cell', d.would_block ? 'text-warn-fg' : 'text-subtle')}>{d.would_block ? fmtCompact(d.would_block) : '–'}</td>
                      <td className={cn(td, 'hidden text-right tnum lg:table-cell')}>{d.devices ?? '–'}</td>
                      <td className={cn(td, 'hidden text-xs text-muted xl:table-cell')}><RelTime ts={d.last_seen} /></td>
                      <td className={cn(td, 'text-right whitespace-nowrap')}><DomainRule d={d} busy={busy} onRule={rule} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <ul className="divide-y divide-line md:hidden">
              {list.map((d) => (
                <li key={d.domain} className="px-4 py-3">
                  <p className="font-mono text-[12.5px] break-all text-fg">{d.domain}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <CategoryBadge cat={d.category} />
                    <span>{fmtNum(d.queries)} lookups</span>
                    {d.blocked > 0 && <span className="text-crit-fg">{fmtCompact(d.blocked)} blocked</span>}
                    {d.would_block > 0 && <span className="text-warn-fg">{fmtCompact(d.would_block)} would block</span>}
                  </div>
                  <div className="mt-2"><DomainRule d={d} busy={busy} onRule={rule} /></div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      {list.length >= 200 && <p className="mt-2 text-xs text-muted">Showing the top 200. Search to narrow it down.</p>}
    </div>
  );
}

function DomainRule({ d, busy, onRule }: { d: DnsDomainStat; busy: string | null; onRule: (d: DnsDomainStat, a: 'block' | 'allow') => void }) {
  if (d.rule === 'block') return <Link to="/dns/rules"><Badge tone="crit" icon={Ban}>Blocked by you</Badge></Link>;
  if (d.rule === 'allow') return <Link to="/dns/rules"><Badge tone="ok" icon={Check}>Allowed by you</Badge></Link>;
  return (
    <span className="inline-flex gap-1">
      <Button size="xs" icon={Ban} loading={busy === `${d.domain}:block`} onClick={() => onRule(d, 'block')} aria-label={`Block ${d.domain}`}>Block</Button>
      <Button size="xs" variant="ghost" icon={Check} loading={busy === `${d.domain}:allow`} onClick={() => onRule(d, 'allow')} aria-label={`Allow ${d.domain}`}>Allow</Button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Rules

function RulesTab() {
  const rules = useQuery('rules', api.dns.rules);
  const sites = useQuery('sites', () => api.sites.list());
  const clients = useQuery('clients', api.clients.list);
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<'all' | 'user' | 'curated'>('all');
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState<DnsRule | null>(null);

  const scopeName = (r: DnsRule) =>
    r.scope_type === 'global' ? 'Everywhere'
      : r.scope_type === 'site' ? `Site: ${sites.data?.find((s) => s.id === r.scope_id)?.name ?? r.scope_id}`
        : `Client: ${clients.data?.find((c) => c.id === r.scope_id)?.name ?? r.scope_id}`;

  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (rules.data ?? []).filter((r) => (source === 'all' || r.source === source) && (!s || r.domain.includes(s) || (r.vendor ?? '').toLowerCase().includes(s) || (r.notes ?? '').toLowerCase().includes(s)));
  }, [rules.data, search, source]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search rules" className="w-full sm:w-64" />
        <Segmented<'all' | 'user' | 'curated'> ariaLabel="Who made the rule" size="sm" value={source} onChange={setSource} options={[{ value: 'all', label: 'All' }, { value: 'user', label: 'Yours' }, { value: 'curated', label: 'Built-in' }]} />
        <Button variant="primary" icon={Plus} className="sm:ml-auto" onClick={() => setAdding(true)}>Add rule</Button>
      </div>
      <p className="mb-3 text-sm text-muted">Rules override the blocklists. A rule for <span className="font-mono">example.com</span> also covers everything under it, like <span className="font-mono">ads.example.com</span>. Allow rules win over block rules.</p>
      <Card>
        {rules.loading ? (
          <div className="p-4"><SkeletonRows rows={8} /></div>
        ) : list.length === 0 ? (
          <EmptyState icon={ListFilter} title="No rules here" action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add rule</Button>}>Block or allow a domain everywhere, for one client or for one site.</EmptyState>
        ) : (
          <TableWrap>
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-line bg-surface-2/60">
                <tr><th className={th}>Domain</th><th className={th}>Rule</th><th className={th}>Where</th><th className={th}>Policies</th><th className={th}>Notes</th><th className={th}>Added</th><th className={cn(th, 'w-10')}><span className="sr-only">Delete</span></th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((r) => (
                  <tr key={`${r.domain}|${r.scope_type}|${r.scope_id}`} className="hover:bg-surface-2/50">
                    <td className={td}>
                      <span className="block font-mono text-[12.5px] text-fg">{r.domain}</span>
                      <span className="mt-0.5 flex items-center gap-1.5">{r.category && <CategoryBadge cat={r.category} />}{r.vendor && <span className="text-xs text-muted">{r.vendor}</span>}</span>
                    </td>
                    <td className={td}>{r.action === 'block' ? <Badge tone="crit" icon={Ban}>Block</Badge> : <Badge tone="ok" icon={Check}>Allow</Badge>}</td>
                    <td className={cn(td, 'text-muted')}>{scopeName(r)}</td>
                    <td className={td}><span className="flex flex-wrap gap-1">{r.policies.map((p) => <Badge key={p}>{POLICY[p].label}</Badge>)}</span></td>
                    <td className={cn(td, 'max-w-56 text-xs text-muted')}>{r.notes ?? '–'}</td>
                    <td className={cn(td, 'text-xs whitespace-nowrap text-muted')}>{r.source === 'curated' ? 'Built-in' : <RelTime ts={r.created_at} />}</td>
                    <td className={td}><IconButton icon={Trash2} label={`Delete rule for ${r.domain}`} size="sm" variant="danger-ghost" onClick={() => setDel(r)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
      <AddRuleDialog open={adding} onClose={() => setAdding(false)} sites={sites.data ?? []} clients={clients.data ?? []} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        danger
        title={`Delete the rule for ${del?.domain}?`}
        confirmLabel="Delete rule"
        onConfirm={async () => {
          if (!del) return;
          const ok = await act(() => api.dns.deleteRule(del), { success: 'Rule deleted. Gateways update within a minute.', invalidate: ['rules', 'dns-'] });
          if (ok) setDel(null);
        }}
      >
        <p>{del?.source === 'curated' ? 'This is a built-in rule maintained by Screens. Deleting it means the domain is handled by the blocklists alone.' : `${del?.domain} will be handled by the blocklists again.`}</p>
      </ConfirmDialog>
    </div>
  );
}

function AddRuleDialog({ open, onClose, sites, clients }: { open: boolean; onClose: () => void; sites: { id: string; name: string }[]; clients: { id: string; name: string }[] }) {
  const [domain, setDomain] = useState('');
  const [action, setAction] = useState<'block' | 'allow'>('block');
  const [scope, setScope] = useState<'global' | 'client' | 'site'>('global');
  const [scopeId, setScopeId] = useState('');
  const [policies, setPolicies] = useState<DnsPolicyName[]>(['balanced', 'strict']);
  const [category, setCategory] = useState<DnsCategory | ''>('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const domErr = domain ? isDomain(domain.trim().toLowerCase()) : null;
  const ok = domain && !domErr && policies.length && (scope === 'global' || scopeId);
  const submit = async () => {
    setBusy(true);
    const r = await act(() => api.dns.addRule({ domain: domain.trim().toLowerCase(), action, scope_type: scope, scope_id: scope === 'global' ? '' : scopeId, policies, category: category || null, notes: notes.trim() || null }), {
      success: `${action === 'block' ? 'Blocking' : 'Allowing'} ${domain}. Gateways update within a minute.`,
      invalidate: ['rules', 'dns-', 'privacy'],
    });
    setBusy(false);
    if (r) {
      setDomain('');
      setNotes('');
      onClose();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a DNS rule"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ok} onClick={submit}>Add rule</Button></>}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ok) void submit(); }}>
        <Field label="Domain" htmlFor="rule-domain" error={domErr} hint="Covers the domain and everything under it.">
          <Input id="rule-domain" mono value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="tracking.example.com" autoFocus />
        </Field>
        <Field label="Rule">
          <Segmented<'block' | 'allow'>
            ariaLabel="Block or allow"
            value={action}
            onChange={(a) => { setAction(a); setPolicies(a === 'block' ? ['balanced', 'strict'] : ['balanced', 'strict', 'monitor']); }}
            options={[{ value: 'block', label: 'Block', icon: Ban }, { value: 'allow', label: 'Allow', icon: Check }]}
          />
          <p className="mt-1.5 text-xs text-muted">{action === 'block' ? 'Devices get “no such site” for this domain.' : 'Never blocked, even if a blocklist includes it — use this when blocking breaks an app.'}</p>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Where" htmlFor="rule-scope">
            <Select id="rule-scope" value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setScopeId(''); }}>
              <option value="global">Everywhere</option>
              <option value="client">One client’s sites</option>
              <option value="site">One site</option>
            </Select>
          </Field>
          {scope !== 'global' && (
            <Field label={scope === 'site' ? 'Site' : 'Client'} htmlFor="rule-scope-id">
              <Select id="rule-scope-id" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                <option value="">Choose…</option>
                {(scope === 'site' ? sites : clients).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </Field>
          )}
        </div>
        <Field label="Applies to devices using">
          <div className="space-y-1.5">
            {POLICIES.map((p) => (
              <Checkbox key={p} checked={policies.includes(p)} onChange={(v) => setPolicies(v ? [...policies, p] : policies.filter((x) => x !== p))} label={POLICY[p].label} description={POLICY[p].help} />
            ))}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" htmlFor="rule-cat" optional>
            <Select id="rule-cat" value={category} onChange={(e) => setCategory(e.target.value as DnsCategory | '')}>
              <option value="">–</option>
              {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY[c].label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Notes" htmlFor="rule-notes" optional><Textarea id="rule-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why this rule exists" /></Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Blocklists

function ListsTab() {
  const q = useQuery('lists', api.dns.lists);
  const [building, setBuilding] = useState(false);
  const data = q.data;
  const patch = async (l: DnsList, p: Partial<Pick<DnsList, 'enabled' | 'policies'>>) => {
    setQueryData<typeof data>('lists', (old) => old && { ...old, lists: old.lists.map((x) => (x.id === l.id ? { ...x, ...p } : x)) });
    await act(() => api.dns.updateList(l.id, p), { invalidate: ['lists'] });
  };
  const rebuild = async () => {
    setBuilding(true);
    const r = await act(() => api.dns.rebuild(), { success: 'Policies rebuilt and sent to every online gateway', invalidate: ['lists', 'jobs'] });
    setBuilding(false);
    if (r) setQueryData<typeof data>('lists', (old) => old && { ...old, builds: r.builds });
  };
  return (
    <div className="space-y-4">
      <Callout kind="info">
        Blocklists are community-maintained lists of tracking, ad and malware domains. Screens fetches them, adds your rules, and compiles one policy per level (Balanced, Strict…) that every gateway downloads.
        Changes here take effect after <strong className="text-fg">Rebuild &amp; push</strong> (it also runs by itself every few hours).
      </Callout>
      <Card>
        <CardHeader
          title="Compiled policies"
          icon={ShieldCheck}
          subtitle="What the gateways are using right now"
          actions={<Button variant="primary" icon={building ? undefined : Hammer} loading={building} onClick={rebuild}>{building ? 'Rebuilding…' : 'Rebuild & push'}</Button>}
        />
        <CardBody>
          {!data ? <SkeletonRows rows={3} /> : (
            <ul className="grid gap-3 sm:grid-cols-3">
              {data.builds.map((b) => (
                <li key={b.policy} className="rounded-lg border border-line bg-surface-2/50 p-3">
                  <p className="text-sm font-semibold text-fg">{POLICY[b.policy].label}</p>
                  <p className="mt-1 text-2xl font-semibold tracking-tight text-fg">{fmtCompact(b.rules)}<span className="ml-1 text-xs font-normal text-muted">domains</span></p>
                  <p className="mt-1 text-xs text-muted">Built <RelTime ts={b.built_at} /></p>
                  <p className="mt-0.5 font-mono text-[11px] text-subtle" title={b.sha256}>{truncateMiddle(b.sha256, 20)}</p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Sources" icon={ListChecks} subtitle="Turn lists on or off, and choose which policies use them." />
        {!data ? (
          <CardBody><SkeletonRows rows={6} /></CardBody>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {data.lists.map((l) => (
              <li key={l.id} className={cn('px-4 py-3.5', !l.enabled && 'bg-surface-2/40')}>
                <div className="flex flex-wrap items-start gap-3">
                  <Toggle checked={l.enabled} onChange={(v) => patch(l, { enabled: v })} ariaLabel={`Use ${l.name}`} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                      {l.name}
                      <CategoryBadge cat={l.category} />
                      <Badge mono>{l.format}</Badge>
                    </p>
                    <a href={l.url} target="_blank" rel="noreferrer noopener" className="mt-0.5 inline-flex max-w-full items-center gap-1 font-mono text-[11.5px] text-muted hover:text-fg hover:underline">
                      <span className="truncate">{l.url}</span>
                      <ExternalLink className="size-3 shrink-0" aria-hidden />
                    </a>
                    <p className="mt-1 text-xs text-muted">
                      {l.last_count != null ? `${fmtNum(l.last_count)} domains` : 'Not fetched yet'}
                      {l.last_fetched && <> · fetched <RelTime ts={l.last_fetched} /></>}
                    </p>
                    {l.last_error && (
                      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-crit-fg"><TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />Last download failed: {l.last_error}. The previous copy is still used.</p>
                    )}
                  </div>
                  <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5 max-sm:w-full max-sm:pl-12" disabled={!l.enabled}>
                    <legend className="sr-only">Policies using {l.name}</legend>
                    {POLICIES.filter((p) => p !== 'monitor').map((p) => (
                      <Checkbox key={p} checked={l.policies.includes(p)} disabled={!l.enabled} onChange={(v) => patch(l, { policies: v ? [...l.policies, p] : l.policies.filter((x) => x !== p) })} label={POLICY[p].label} />
                    ))}
                  </fieldset>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="flex items-center gap-1.5 text-xs text-muted"><RefreshCw className="size-3.5" aria-hidden />The Monitor policy uses the same lists as Balanced but never blocks — it only records what would be blocked.</p>
    </div>
  );
}
