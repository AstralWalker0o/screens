import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Building2, Plus, UserPlus, Ellipsis, Trash2, Pencil, MapPin, Clock, TvMinimalPlay, Globe, TriangleAlert, ChevronRight, Users } from 'lucide-react';
import type { Client, SiteKind, SiteSummary } from '../../shared/types';
import { api } from '../api';
import { act, useQuery } from '../lib/query';
import { fmtCompact, fmtPct } from '../lib/format';
import { allTimezones, SITE_KIND } from '../lib/labels';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, SkeletonRows, StatusText } from '../components/ui';
import { ConfirmDialog, Dialog, Menu } from '../components/overlay';
import { Field, Input, Segmented, Select, Textarea } from '../components/forms';
import { GatewayBadge } from '../components/status';

export default function Sites() {
  const clients = useQuery('clients', api.clients.list);
  const sites = useQuery('sites', () => api.sites.list());
  const [newClient, setNewClient] = useState(false);
  const [editClient, setEditClient] = useState<Client | null>(null);
  const [newSite, setNewSite] = useState<{ clientId?: string } | null>(null);
  const [delSite, setDelSite] = useState<SiteSummary | null>(null);
  const [delClient, setDelClient] = useState<Client | null>(null);
  const navigate = useNavigate();

  const loading = clients.loading || sites.loading;
  const byClient = new Map<string, SiteSummary[]>();
  for (const s of sites.data ?? []) byClient.set(s.client_id, [...(byClient.get(s.client_id) ?? []), s]);

  return (
    <>
      <PageHeader
        title="Sites"
        subtitle="A site is one place — a home, a rental or an office — with its own gateway. Sites are grouped by client."
        actions={
          <>
            <Button icon={UserPlus} onClick={() => setNewClient(true)}>New client</Button>
            <Button variant="primary" icon={Plus} onClick={() => setNewSite({})} disabled={!clients.data?.length}>New site</Button>
          </>
        }
      />

      {loading ? (
        <SkeletonRows rows={6} />
      ) : !clients.data?.length ? (
        <Card>
          <EmptyState icon={Users} title="Start by adding a client" action={<Button variant="primary" icon={UserPlus} onClick={() => setNewClient(true)}>New client</Button>}>
            A client is whoever owns the place — yourself, a family member or a rental business. Each client can have several sites.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-8">
          {clients.data.map((c) => {
            const list = byClient.get(c.id) ?? [];
            return (
              <section key={c.id} aria-labelledby={`client-${c.id}`}>
                <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h2 id={`client-${c.id}`} className="text-base font-semibold text-fg">{c.name}</h2>
                  <span className="text-sm text-muted">{list.length} site{list.length === 1 ? '' : 's'}{c.contact ? ` · ${c.contact}` : ''}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" icon={Plus} onClick={() => setNewSite({ clientId: c.id })}>Add site</Button>
                    <Menu
                      trigger={({ toggle, ref }) => <IconButton ref={ref} icon={Ellipsis} label={`More actions for ${c.name}`} onClick={toggle} size="sm" />}
                      items={[
                        { label: 'Edit client', icon: Pencil, onSelect: () => setEditClient(c) },
                        { label: 'Delete client', icon: Trash2, danger: true, onSelect: () => setDelClient(c) },
                      ]}
                    />
                  </div>
                </div>
                {c.notes && <p className="-mt-2 mb-3 text-sm text-muted">{c.notes}</p>}
                {list.length ? (
                  <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {list.map((s) => <SiteCard key={s.id} site={s} onDelete={() => setDelSite(s)} />)}
                  </ul>
                ) : (
                  <Card className="border-dashed">
                    <EmptyState icon={Building2} title={`${c.name} has no sites yet`} action={<Button icon={Plus} onClick={() => setNewSite({ clientId: c.id })}>Add a site</Button>} className="py-7" />
                  </Card>
                )}
              </section>
            );
          })}
        </div>
      )}

      <ClientDialog open={newClient} onClose={() => setNewClient(false)} />
      <ClientDialog open={!!editClient} client={editClient ?? undefined} onClose={() => setEditClient(null)} />
      <NewSiteDialog
        open={!!newSite}
        clientId={newSite?.clientId}
        clients={clients.data ?? []}
        onClose={() => setNewSite(null)}
        onCreated={(id) => navigate(`/sites/${id}/gateway`)}
      />
      <ConfirmDialog
        open={!!delSite}
        onClose={() => setDelSite(null)}
        danger
        title={`Delete ${delSite?.name}?`}
        confirmLabel="Delete site"
        typeToConfirm={delSite?.name}
        onConfirm={async () => {
          if (!delSite) return;
          const ok = await act(() => api.sites.remove(delSite.id), { success: `Deleted ${delSite.name}`, invalidate: ['sites', 'site', 'overview', 'devices', 'clients'] });
          if (ok) setDelSite(null);
        }}
      >
        <p>This removes the site, its {delSite?.devices_total ?? 0} devices and all their history. Its gateway stops filtering DNS and can’t reconnect.</p>
        <p>The TVs and speakers themselves aren’t changed.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!delClient}
        onClose={() => setDelClient(null)}
        danger
        title={`Delete ${delClient?.name}?`}
        confirmLabel="Delete client"
        onConfirm={async () => {
          if (!delClient) return;
          const ok = await act(() => api.clients.remove(delClient.id), { success: `Deleted ${delClient.name}`, invalidate: ['clients'] });
          if (ok) setDelClient(null);
        }}
      >
        <p>{(byClient.get(delClient?.id ?? '') ?? []).length ? 'Delete this client’s sites first — a client with sites can’t be removed.' : 'The client has no sites, so nothing else is affected.'}</p>
      </ConfirmDialog>
    </>
  );
}

function SiteCard({ site: s, onDelete }: { site: SiteSummary; onDelete: () => void }) {
  return (
    <li>
      <Card className="group relative flex h-full flex-col p-4 transition-colors hover:border-line-strong">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link to={`/sites/${s.id}`} className="text-[15px] font-semibold text-fg after:absolute after:inset-0 after:content-[''] hover:underline">
              {s.name}
            </Link>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-xs text-muted">
              {s.address && <span className="inline-flex items-center gap-1"><MapPin className="size-3" aria-hidden />{s.address}</span>}
              <span className="inline-flex items-center gap-1"><Clock className="size-3" aria-hidden />{s.timezone.replace('_', ' ')}</span>
            </p>
          </div>
          <div className="relative z-10 flex items-center gap-1">
            <Badge tone={s.kind === 'rental' ? 'accent' : 'neutral'}>{SITE_KIND[s.kind].label}</Badge>
            <Menu
              trigger={({ toggle, ref }) => <IconButton ref={ref} icon={Ellipsis} label={`More actions for ${s.name}`} onClick={toggle} size="sm" />}
              items={[{ label: 'Delete site…', icon: Trash2, danger: true, onSelect: onDelete }]}
            />
          </div>
        </div>
        <div className="mt-3">
          <GatewayBadge status={s.gateway_status} />
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-sm">
          <div>
            <dt className="flex items-center gap-1 text-xs text-muted"><TvMinimalPlay className="size-3" aria-hidden />Devices up</dt>
            <dd className="mt-0.5 font-semibold text-fg tnum">{s.devices_online}/{s.devices_total}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1 text-xs text-muted"><Globe className="size-3" aria-hidden />Lookups</dt>
            <dd className="mt-0.5 font-semibold text-fg tnum">{s.dns_queries_24h ? fmtCompact(s.dns_queries_24h) : '–'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Blocked</dt>
            <dd className="mt-0.5 font-semibold text-fg tnum">{s.dns_queries_24h ? fmtPct(s.dns_blocked_24h, s.dns_queries_24h) : '–'}</dd>
          </div>
        </dl>
        <div className="mt-3 flex items-center justify-between text-xs">
          {s.alerts_open > 0 ? (
            <StatusText tone="warn" icon={TriangleAlert}>{s.alerts_open} open alert{s.alerts_open === 1 ? '' : 's'}</StatusText>
          ) : s.gateway_status === 'none' ? (
            <span className="text-muted">Next step: add a gateway</span>
          ) : (
            <span className="text-muted">No open alerts</span>
          )}
          <ChevronRight className="size-4 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
        </div>
      </Card>
    </li>
  );
}

function ClientDialog({ open, onClose, client }: { open: boolean; onClose: () => void; client?: Client }) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);
  const key = client?.id ?? 'new';
  if (open && seeded !== key) {
    setSeeded(key);
    setName(client?.name ?? '');
    setContact(client?.contact ?? '');
    setNotes(client?.notes ?? '');
  }
  if (!open && seeded) setSeeded(null);
  const submit = async () => {
    setBusy(true);
    const body = { name: name.trim(), contact: contact.trim() || undefined, notes: notes.trim() || undefined };
    const r = client
      ? await act(() => api.clients.update(client.id, body), { success: 'Client saved', invalidate: ['clients', 'sites'] })
      : await act(() => api.clients.create(body), { success: `Added ${body.name}`, invalidate: ['clients'] });
    setBusy(false);
    if (r) onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={client ? 'Edit client' : 'New client'}
      description="Who owns or manages the place — you, family, or a business you look after."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={submit}>{client ? 'Save' : 'Add client'}</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void submit(); }}>
        <Field label="Name" htmlFor="client-name">
          <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Coastal Rentals" autoFocus />
        </Field>
        <Field label="Contact" htmlFor="client-contact" optional hint="Email or phone, for your reference.">
          <Input id="client-contact" value={contact} onChange={(e) => setContact(e.target.value)} />
        </Field>
        <Field label="Notes" htmlFor="client-notes" optional>
          <Textarea id="client-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function NewSiteDialog({ open, onClose, clients, clientId, onCreated }: {
  open: boolean; onClose: () => void; clients: Client[]; clientId?: string; onCreated: (id: string) => void;
}) {
  const [cid, setCid] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SiteKind>('residential');
  const [tz, setTz] = useState('Australia/Sydney');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setCid(clientId ?? clients[0]?.id ?? '');
    setName('');
    setKind('residential');
    setTz('Australia/Sydney');
    setAddress('');
  }
  if (!open && wasOpen) setWasOpen(false);
  const submit = async () => {
    setBusy(true);
    const r = await act(() => api.sites.create({ client_id: cid, name: name.trim(), kind, timezone: tz, address: address.trim() || undefined }), {
      success: (s) => `Created ${s.name}. Next: add its gateway.`,
      invalidate: ['sites', 'clients', 'overview'],
    });
    setBusy(false);
    if (r) {
      onClose();
      onCreated(r.id);
    }
  };
  const zones = allTimezones();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New site"
      description="After creating it you’ll add a gateway — a small Linux machine at the site that filters DNS and talks to the TVs."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !cid} onClick={submit}>Create site</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && cid) void submit(); }}>
        <Field label="Client" htmlFor="site-client">
          <Select id="site-client" value={cid} onChange={(e) => setCid(e.target.value)}>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Site name" htmlFor="site-name" hint="What you call the place, e.g. “Beach House”.">
          <Input id="site-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Kind of place">
          <Segmented<SiteKind>
            ariaLabel="Kind of place"
            value={kind}
            onChange={setKind}
            options={(['residential', 'rental', 'business'] as SiteKind[]).map((k) => ({ value: k, label: SITE_KIND[k].label }))}
          />
          <p className="mt-1.5 text-xs text-muted">{SITE_KIND[kind].help}</p>
        </Field>
        <Field label="Time zone" htmlFor="site-tz" hint="Schedules like “turn TVs off at midnight” use this time zone.">
          <Select id="site-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </Select>
        </Field>
        <Field label="Address" htmlFor="site-address" optional>
          <Input id="site-address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

