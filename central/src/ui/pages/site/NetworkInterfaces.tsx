import { useState } from 'react';
import { Network, Plus, Trash2, Wifi, WifiOff, CircleCheck, Loader2, TriangleAlert, Info } from 'lucide-react';
import type { GatewayInterface, NetIfaceConfig, NetIfaceStatus, NetworkState, SiteDetail } from '../../../shared/types';
import { api } from '../../api';
import { act, setQueryData, useQuery } from '../../lib/query';
import { Badge, Button, Callout, Card, CardHeader, IconButton, RelTime, SkeletonRows, StatusText, TableWrap, td, th, cn } from '../../components/ui';
import { Field, Input, Segmented, Select } from '../../components/forms';
import { ConfirmDialog, Dialog } from '../../components/overlay';

/** Interface names the gateway never manages or offers (mirrors gateway/internal/netcfg). */
const HIDDEN = /^(lo|docker|br-|veth|cni|flannel|tailscale|wg|tun|tap|virbr|zt)/;
const legName = (l: NetIfaceConfig) => (l.kind === 'vlan' ? `scr${l.vlan}` : l.name ?? '');
const v4 = (addrs: string[]) => addrs.filter((a) => /^\d+\.\d+\.\d+\.\d+\//.test(a));

interface Row { name: string; host?: GatewayInterface; leg?: NetIfaceConfig; status?: NetIfaceStatus }

export function NetworkInterfaces({ site }: { site: SiteDetail }) {
  const key = `network:${site.id}`;
  const q = useQuery(key, () => api.sites.network(site.id), { refreshMs: 15_000 });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<NetIfaceConfig | null>(null);
  const s = q.data;

  const save = async (interfaces: NetIfaceConfig[], success: string) => {
    const r = await act(() => api.sites.saveNetwork(site.id, { interfaces }), { success, invalidate: [`gateway:${site.id}`] });
    if (r) setQueryData<NetworkState>(key, () => r);
    return !!r;
  };

  const rows: Row[] = [];
  if (s) {
    const legs = new Map(s.config.interfaces.map((l) => [legName(l), l]));
    const status = new Map(s.status.map((x) => [x.name, x]));
    for (const h of s.host.filter((h) => !HIDDEN.test(h.name))) rows.push({ name: h.name, host: h, leg: legs.get(h.name), status: status.get(h.name) });
    for (const [name, leg] of legs) if (!rows.some((r) => r.name === name)) rows.push({ name, leg, status: status.get(name) });
  }

  return (
    <Card>
      <CardHeader
        title="Network interfaces"
        icon={Network}
        subtitle="The gateway needs a leg on every VLAN that has TVs, boxes or speakers."
        actions={<Button size="sm" icon={Plus} onClick={() => setAdding(true)} disabled={!s?.supported}>Add network</Button>}
      />
      {!s ? (
        <div className="p-4"><SkeletonRows rows={3} /></div>
      ) : (
        <>
          {!s.supported && (
            <div className="px-4 pb-3">
              <Callout kind="info" title="Update the gateway to manage networks here">
                This gateway’s version can’t add VLANs yet. Use <span className="font-medium">Update</span> above, then come back.
              </Callout>
            </div>
          )}
          {s.errors.length > 0 && (
            <div className="px-4 pb-3">
              <Callout kind="warn" title="The gateway reported a problem">{s.errors.join(' · ')}</Callout>
            </div>
          )}
          <TableWrap>
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-y border-line bg-surface-2/60">
                <tr><th className={th}>Name</th><th className={th}>Network</th><th className={th}>Addresses</th><th className={th}>Status</th><th className={cn(th, 'w-10')}><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td className={cn(td, 'font-mono text-[13px] font-medium')}>
                      {r.name}
                      {r.leg?.label && <span className="ml-2 font-sans text-xs font-normal text-muted">{r.leg.label}</span>}
                    </td>
                    <td className={cn(td, 'text-muted')}>
                      {r.leg?.kind === 'vlan' ? <>VLAN {r.leg.vlan} on <span className="font-mono text-[13px]">{r.leg.parent}</span></> : r.leg ? 'Spare port' : 'Set up on the machine'}
                      {r.leg && <Badge tone="accent" className="ml-2">Screens</Badge>}
                    </td>
                    <td className={cn(td, 'font-mono text-[13px]')}>{v4(r.status?.addrs ?? r.host?.addrs ?? []).join(', ') || <span className="font-sans text-muted">–</span>}</td>
                    <td className={td}><LegStatus row={r} /></td>
                    <td className={td}>
                      {r.leg && <IconButton icon={Trash2} label={`Remove ${r.name}`} size="sm" onClick={() => setRemoving(r.leg!)} />}
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td className={cn(td, 'text-muted')} colSpan={5}>The gateway hasn’t reported its interfaces yet.</td></tr>}
              </tbody>
            </table>
          </TableWrap>
          <p className="flex items-start gap-1.5 px-4 py-3 text-xs text-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Networks added here only give the gateway an address on that VLAN (no routes, no DNS changes), so your router and the machine’s own network stay as they are.
              {s.updated_at && <> Checked <RelTime ts={s.updated_at} />.</>}
            </span>
          </p>
        </>
      )}

      {s && <AddNetworkDialog open={adding} onClose={() => setAdding(false)} state={s} onSave={async (leg) => { if (await save([...s.config.interfaces, leg], `Adding ${legName(leg)}. It gets an address in a few seconds.`)) setAdding(false); }} />}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        danger
        title={`Remove ${removing ? legName(removing) : ''}?`}
        confirmLabel="Remove"
        onConfirm={async () => { if (s && removing && (await save(s.config.interfaces.filter((l) => l !== removing), `${legName(removing)} removed`))) setRemoving(null); }}
      >
        <p>The gateway gives up its address on this network. Devices there lose the Screens DNS filter (if they use it) and discovery, remote control and mDNS on that VLAN stop.</p>
      </ConfirmDialog>
    </Card>
  );
}

function LegStatus({ row }: { row: Row }) {
  const st = row.status;
  if (row.leg && st?.state === 'error') return <StatusText tone="crit" icon={TriangleAlert} title={st.error}>{st.error ?? 'Error'}</StatusText>;
  if (row.leg && (st?.state === 'acquiring' || !st)) return <StatusText tone="neutral" icon={Loader2} pulse>{row.leg.mode === 'dhcp' ? 'Getting an address…' : 'Setting up…'}</StatusText>;
  if (row.host && !row.host.up) return <StatusText tone="crit" icon={WifiOff}>Down</StatusText>;
  if (row.leg && st?.expires) return <StatusText tone="ok" icon={CircleCheck}>Up · lease renews automatically</StatusText>;
  if (row.host) return <StatusText tone="ok" icon={Wifi}>Up{!row.host.multicast && ' · no multicast'}</StatusText>;
  return <StatusText tone="ok" icon={CircleCheck}>Up</StatusText>;
}

function AddNetworkDialog({ open, onClose, state, onSave }: { open: boolean; onClose: () => void; state: NetworkState; onSave: (l: NetIfaceConfig) => Promise<void> }) {
  const managed = new Set(state.config.interfaces.map(legName));
  const ports = state.host.filter((h) => !HIDDEN.test(h.name) && !h.name.startsWith('scr') && !h.name.includes('.'));
  const spare = ports.filter((h) => !managed.has(h.name) && !v4(h.addrs).length);
  const [kind, setKind] = useState<'vlan' | 'existing'>(spare.length ? 'existing' : 'vlan');
  const [parent, setParent] = useState('');
  const [vlan, setVlan] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'dhcp' | 'static'>('dhcp');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const p = parent || ports[0]?.name || '';
  const n = name || spare[0]?.name || '';
  const vlanNum = Number(vlan);
  const vlanOk = Number.isInteger(vlanNum) && vlanNum >= 1 && vlanNum <= 4094;
  const dup = kind === 'vlan' ? managed.has(`scr${vlanNum}`) : managed.has(n);
  const addrOk = mode === 'dhcp' || /^\d{1,3}(\.\d{1,3}){3}\/([89]|[12]\d|30)$/.test(address.trim());
  const valid = (kind === 'vlan' ? !!p && vlanOk : !!n) && addrOk && !dup;

  const submit = async () => {
    setBusy(true);
    const leg: NetIfaceConfig = kind === 'vlan' ? { kind, parent: p, vlan: vlanNum, mode } : { kind, name: n, mode };
    if (mode === 'static') leg.address = address.trim();
    if (label.trim()) leg.label = label.trim();
    await onSave(leg);
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a network to the gateway"
      description="Give the gateway an address on another VLAN so it can find, pair with and filter the devices there."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={Plus} loading={busy} disabled={!valid} onClick={submit}>Add network</Button></>}
    >
      <div className="space-y-4">
        <Field label="How does the VLAN reach the gateway?">
          <Segmented<'vlan' | 'existing'>
            ariaLabel="Connection type"
            value={kind}
            onChange={setKind}
            options={[{ value: 'existing', label: 'Its own network port' }, { value: 'vlan', label: 'Tagged on a port (trunk)' }]}
          />
        </Field>
        {kind === 'existing' ? (
          <Field label="Network port" htmlFor="net-name" hint="Ports that the machine hasn’t configured itself. For example, a second network device you added to the VM for this VLAN.">
            {spare.length ? (
              <Select id="net-name" value={n} onChange={(e) => setName(e.target.value)}>
                {spare.map((h) => <option key={h.name} value={h.name}>{h.name}{h.mac ? ` (${h.mac})` : ''}</option>)}
              </Select>
            ) : (
              <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">No spare ports. In Proxmox, add a network device to the gateway VM with the VLAN tag (e.g. 50). It appears here within a minute, with no reboot. Or use “Tagged on a port”.</p>
            )}
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Port carrying the VLAN" htmlFor="net-parent">
              <Select id="net-parent" value={p} onChange={(e) => setParent(e.target.value)}>
                {ports.map((h) => <option key={h.name} value={h.name}>{h.name}{v4(h.addrs).length ? ` (${v4(h.addrs)[0]})` : ''}</option>)}
              </Select>
            </Field>
            <Field label="VLAN ID" htmlFor="net-vlan" error={vlan && !vlanOk ? '1–4094' : dup ? 'Already added' : undefined}>
              <Input id="net-vlan" inputMode="numeric" placeholder="50" value={vlan} onChange={(e) => setVlan(e.target.value.replace(/\D/g, '').slice(0, 4))} />
            </Field>
            <p className="text-xs text-muted sm:col-span-2">
              Only works if the switch port (or Proxmox bridge) sends this VLAN <span className="font-medium text-fg">tagged</span> to the machine. A Proxmox VM network device with a VLAN tag set only gets that one VLAN. In that case add a second network device instead and choose “Its own network port”.
            </p>
          </div>
        )}
        <Field label="Address">
          <Segmented<'dhcp' | 'static'> ariaLabel="Address mode" value={mode} onChange={setMode} options={[{ value: 'dhcp', label: 'Automatic (DHCP)' }, { value: 'static', label: 'Fixed address' }]} />
        </Field>
        {mode === 'static' ? (
          <Field label="Fixed address" htmlFor="net-addr" hint="An unused address on that VLAN, with its prefix." error={address && !addrOk ? 'Use the form 10.10.50.5/24' : undefined}>
            <Input id="net-addr" mono placeholder="10.10.50.5/24" value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
        ) : (
          <p className="text-xs text-muted">The gateway asks the VLAN’s DHCP server for an address. Only the address is used: no default route and no DNS servers, so the gateway’s internet path doesn’t change. Add a DHCP reservation for it if TVs will use it as their DNS server.</p>
        )}
        <Field label="Label" htmlFor="net-label" optional>
          <Input id="net-label" placeholder="e.g. IoT, TVs, Guest" value={label} onChange={(e) => setLabel(e.target.value.slice(0, 40))} />
        </Field>
      </div>
    </Dialog>
  );
}
