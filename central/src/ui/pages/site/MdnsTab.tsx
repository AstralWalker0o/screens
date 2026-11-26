import { useEffect, useMemo, useState } from 'react';
import { Share2, Plus, Trash2, ArrowRight, Save, Radio, Gauge, ListTree, Router, Undo2 } from 'lucide-react';
import type { MdnsConfig, MdnsRule, SiteDetail, GatewayInterface } from '../../../shared/types';
import { api } from '../../api';
import { act, setQueryData, useQuery } from '../../lib/query';
import { fmtNum } from '../../lib/format';
import { MDNS_SERVICE_NAMES } from '../../lib/labels';
import { Badge, Button, ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState, IconButton, RelTime, SectionLabel, SkeletonRows, cn } from '../../components/ui';
import { Checkbox, ChipsInput, Field, Input, Select, Toggle, isServiceType } from '../../components/forms';

const PRESETS: { label: string; types: string[] }[] = [
  { label: 'Sonos', types: ['_sonos._tcp'] },
  { label: 'AirPlay', types: ['_airplay._tcp', '_raop._tcp'] },
  { label: 'Chromecast', types: ['_googlecast._tcp'] },
  { label: 'Spotify Connect', types: ['_spotify-connect._tcp'] },
  { label: 'Android TV remote', types: ['_androidtvremote2._tcp'] },
  { label: 'HomeKit', types: ['_hap._tcp'] },
  { label: 'Printers', types: ['_ipp._tcp', '_printer._tcp'] },
];

function ifaceLabel(i?: GatewayInterface) {
  if (!i) return '';
  const addr = i.addrs.find((a) => !a.startsWith('fe80')) ?? i.addrs[0] ?? '';
  return `${i.name}${addr ? ` (${addr.split('/')[0].replace(/\.\d+$/, '.x')})` : ''}`;
}

export function MdnsTab({ site }: { site: SiteDetail }) {
  const key = `mdns:${site.id}`;
  const q = useQuery(key, () => api.sites.mdns(site.id), { refreshMs: 5000 });
  const [draft, setDraft] = useState<MdnsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !draft) setDraft(structuredClone(q.data.config));
  }, [q.data, draft]);
  const dirty = useMemo(() => !!draft && !!q.data && JSON.stringify(draft) !== JSON.stringify(q.data.config), [draft, q.data]);

  if (site.gateway_status === 'none' || site.gateway_status === 'revoked') {
    return (
      <Card>
        <EmptyState icon={Router} title="The reflector runs on the gateway" action={<ButtonLink to={`/sites/${site.id}/gateway`} variant="primary" icon={Router}>Add gateway</ButtonLink>}>
          Add a gateway with a network card on each VLAN, then come back here to let apps on one network find speakers and Chromecasts on another.
        </EmptyState>
      </Card>
    );
  }
  if (!q.data || !draft) return <SkeletonRows rows={8} />;

  const ifaces = q.data.interfaces;
  const status = q.data.status;
  const set = (patch: Partial<MdnsConfig>) => setDraft({ ...draft, ...patch });
  const setRule = (i: number, r: MdnsRule) => set({ rules: draft.rules.map((x, k) => (k === i ? r : x)) });
  const chosen = draft.interfaces;

  const save = async () => {
    setBusy(true);
    const ok = await act(() => api.sites.saveMdns(site.id, draft), { success: 'Reflector settings saved. The gateway applies them within a few seconds.' });
    setBusy(false);
    if (ok) setQueryData<typeof q.data>(key, (old) => old && { ...old, config: structuredClone(draft) });
  };

  return (
    <div className="space-y-4">
      <Callout kind="info" title="What is the mDNS reflector?">
        Phones find speakers, Chromecasts and AirPlay devices with mDNS (also called Bonjour) — but those announcements never leave the network they’re made on.
        Sonos speakers on your IoT VLAN announce themselves with mDNS; this copies those announcements to your main VLAN so the Sonos app can find them. Pick only the services you need so the rest stays private.
      </Callout>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Reflector" icon={Share2} />
            <CardBody className="space-y-5">
              <Toggle checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Reflect mDNS between networks" description="Turn off to keep every network completely separate." />
              <div>
                <SectionLabel>Networks to listen on</SectionLabel>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {ifaces.map((i) => (
                    <li key={i.name} className={cn('rounded-lg border px-3 py-2', chosen.includes(i.name) ? 'border-accent/40 bg-accent-soft/40' : 'border-line')}>
                      <Checkbox
                        checked={chosen.includes(i.name)}
                        disabled={!i.multicast || !i.up}
                        onChange={(v) => set({ interfaces: v ? [...chosen, i.name] : chosen.filter((x) => x !== i.name) })}
                        label={<span className="font-mono text-[13px]">{i.name}</span>}
                        description={!i.multicast ? 'No multicast — can’t be used' : !i.up ? 'Link is down' : i.addrs.filter((a) => !a.startsWith('fe80')).join(', ')}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Rules"
              icon={ListTree}
              subtitle="Each rule copies announcements from one network to others. Leave “Allow” empty to copy every kind of service."
              actions={
                <Button size="sm" icon={Plus} disabled={chosen.length < 2} onClick={() => set({ rules: [...draft.rules, { from: chosen[0], to: chosen.filter((c) => c !== chosen[0]).slice(0, 1), allow: [], deny: [] }] })}>
                  Add rule
                </Button>
              }
            />
            <CardBody className="space-y-3">
              {chosen.length < 2 && <Callout kind="warn">Pick at least two networks above before adding rules.</Callout>}
              {draft.rules.length === 0 && chosen.length >= 2 && <p className="py-4 text-center text-sm text-muted">No rules yet — nothing is copied between networks.</p>}
              {draft.rules.map((r, i) => (
                <RuleEditor key={i} rule={r} ifaces={ifaces.filter((x) => chosen.includes(x.name))} onChange={(nr) => setRule(i, nr)} onRemove={() => set({ rules: draft.rules.filter((_, k) => k !== i) })} />
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="SSDP / UPnP" icon={Radio} subtitle="The older discovery protocol used by Sonos S1, DLNA media servers, Roku and some smart TVs." />
            <CardBody className="space-y-4">
              <Toggle checked={draft.ssdp.enabled} onChange={(v) => set({ ssdp: { ...draft.ssdp, enabled: v } })} label="Relay SSDP" description="Only turn this on if an app still can’t find a device with mDNS alone." />
              {draft.ssdp.enabled && (
                <div className="space-y-2">
                  {draft.ssdp.rules.map((r, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Select aria-label="From network" value={r.from} className="w-40" onChange={(e) => set({ ssdp: { ...draft.ssdp, rules: draft.ssdp.rules.map((x, k) => (k === i ? { ...x, from: e.target.value } : x)) } })}>
                        {chosen.map((c) => <option key={c} value={c}>{c}</option>)}
                      </Select>
                      <ArrowRight className="size-4 text-subtle" aria-label="to" />
                      <IfacePicker value={r.to} options={chosen.filter((c) => c !== r.from)} onChange={(to) => set({ ssdp: { ...draft.ssdp, rules: draft.ssdp.rules.map((x, k) => (k === i ? { ...x, to } : x)) } })} />
                      <IconButton icon={Trash2} label="Remove SSDP rule" size="sm" variant="danger-ghost" onClick={() => set({ ssdp: { ...draft.ssdp, rules: draft.ssdp.rules.filter((_, k) => k !== i) } })} />
                    </div>
                  ))}
                  <Button size="sm" variant="ghost" icon={Plus} disabled={chosen.length < 2} onClick={() => set({ ssdp: { ...draft.ssdp, rules: [...draft.ssdp.rules, { from: chosen[0], to: chosen.slice(1, 2) }] } })}>Add SSDP rule</Button>
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Limits" icon={Gauge} />
            <CardBody className="grid gap-5 sm:grid-cols-2">
              <Field label="Rate limit" htmlFor="mdns-rate" hint="Packets per second per network. Protects the network if a device floods announcements. 50 is plenty for a home.">
                <div className="flex items-center gap-2">
                  <Input id="mdns-rate" type="number" min={1} max={1000} className="w-24" value={draft.rate_limit_pps} onChange={(e) => set({ rate_limit_pps: Number(e.target.value) })} />
                  <span className="text-sm text-muted">packets/s</span>
                </div>
              </Field>
              <Toggle checked={draft.track_services} onChange={(v) => set({ track_services: v })} label="Keep a list of services seen" description="Shows what’s announcing itself (right). Doesn’t affect reflection." />
            </CardBody>
          </Card>

          {dirty && (
            <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-line bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur">
              <span className="mr-auto text-sm text-muted">Unsaved changes to the reflector.</span>
              <Button variant="ghost" icon={Undo2} onClick={() => setDraft(structuredClone(q.data!.config))}>Discard</Button>
              <Button variant="primary" icon={Save} loading={busy} onClick={save}>Save & apply</Button>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Live counters" icon={Radio} subtitle={status ? (status.enabled ? 'Updated every few seconds' : 'Reflector is off') : 'Gateway hasn’t reported yet'} />
            <CardBody>
              {status ? (
                <dl className="grid grid-cols-2 gap-3">
                  {([
                    ['Copied', status.counters.reflected, 'Announcements repeated to another network'],
                    ['Filtered', status.counters.filtered, 'Skipped by your allow/deny lists'],
                    ['Rate-limited', status.counters.rate_limited, 'Dropped because a network was too chatty'],
                    ['SSDP relayed', status.counters.ssdp_relayed, 'UPnP messages relayed'],
                  ] as const).map(([k, v, h]) => (
                    <div key={k} className="rounded-lg bg-surface-2 px-3 py-2" title={h}>
                      <dt className="text-xs text-muted">{k}</dt>
                      <dd className="text-lg font-semibold text-fg tnum">{fmtNum(v)}</dd>
                    </div>
                  ))}
                </dl>
              ) : <p className="text-sm text-muted">No data yet.</p>}
              {status && status.interfaces.length > 0 && (
                <table className="mt-4 w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Network</th><th className="pb-1 text-right font-medium">In</th><th className="pb-1 text-right font-medium">Out</th><th className="pb-1 text-right font-medium">Dropped</th></tr></thead>
                  <tbody className="tnum">
                    {status.interfaces.map((i) => (
                      <tr key={i.name} className="border-t border-line">
                        <td className="py-1.5 font-mono text-[13px]">{i.name}</td>
                        <td className="py-1.5 text-right">{fmtNum(i.rx)}</td>
                        <td className="py-1.5 text-right">{fmtNum(i.tx)}</td>
                        <td className={cn('py-1.5 text-right', i.dropped ? 'text-warn-fg' : '')}>{fmtNum(i.dropped)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Services seen" subtitle="What’s announcing itself on the networks" />
            {status?.services.length ? (
              <ul className="max-h-[440px] divide-y divide-line overflow-y-auto border-t border-line">
                {status.services.map((s, i) => (
                  <li key={`${s.service}-${s.instance}-${i}`} className="px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-sm text-fg" title={s.instance}>
                        <span className="font-medium">{MDNS_SERVICE_NAMES[s.service] ?? s.service}</span>
                        <span className="text-muted"> · {s.instance.replace(/^[0-9A-F]{12}@/, '').replace(/^Sonos-[0-9A-F]{12}@/, '')}</span>
                      </span>
                      <span className="shrink-0 text-xs text-subtle"><RelTime ts={s.last_seen} /></span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                      {s.service} · {s.addrs?.[0]}{s.port ? `:${s.port}` : ''} · {s.iface}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <CardBody><p className="text-sm text-muted">{draft.track_services ? 'Nothing seen yet.' : 'Service tracking is off.'}</p></CardBody>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function IfacePicker({ value, options, onChange }: { value: string[]; options: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="To networks">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
            className={cn('h-8 rounded-lg border px-2.5 font-mono text-[12.5px] transition-colors', on ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line-strong text-muted hover:text-fg')}
          >
            {o}
          </button>
        );
      })}
      {!options.length && <span className="text-xs text-muted">Pick more networks above.</span>}
    </div>
  );
}

function RuleEditor({ rule: r, ifaces, onChange, onRemove }: { rule: MdnsRule; ifaces: GatewayInterface[]; onChange: (r: MdnsRule) => void; onRemove: () => void }) {
  const names = ifaces.map((i) => i.name);
  const allowed = new Set(r.allow);
  return (
    <div className="rounded-lg border border-line p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted">From</span>
        <Select aria-label="From network" value={r.from} className="w-44" onChange={(e) => onChange({ ...r, from: e.target.value, to: r.to.filter((t) => t !== e.target.value) })}>
          {names.map((n) => <option key={n} value={n}>{ifaceLabel(ifaces.find((i) => i.name === n))}</option>)}
          {!names.includes(r.from) && <option value={r.from}>{r.from} (not listening)</option>}
        </Select>
        <ArrowRight className="size-4 text-subtle" aria-label="to" />
        <IfacePicker value={r.to} options={names.filter((n) => n !== r.from)} onChange={(to) => onChange({ ...r, to })} />
        <IconButton icon={Trash2} label="Remove rule" size="sm" variant="danger-ghost" onClick={onRemove} className="ml-auto" />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <p className="mb-1 text-sm font-medium text-fg">Allow</p>
          <ChipsInput value={r.allow} onChange={(allow) => onChange({ ...r, allow })} mono placeholder="Everything (type _name._tcp to limit)" validate={isServiceType} ariaLabel="Allowed service types" suggestions={Object.keys(MDNS_SERVICE_NAMES)} />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {PRESETS.map((p) => {
              const on = p.types.every((t) => allowed.has(t));
              return (
                <button
                  key={p.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange({ ...r, allow: on ? r.allow.filter((a) => !p.types.includes(a)) : Array.from(new Set([...r.allow, ...p.types])) })}
                  className={cn('rounded-full border px-2 py-0.5 text-xs transition-colors', on ? 'border-accent/50 bg-accent-soft text-accent-fg' : 'border-line text-muted hover:text-fg')}
                >
                  {on ? '✓ ' : '+ '}{p.label}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-fg">Never copy</p>
          <ChipsInput value={r.deny} onChange={(deny) => onChange({ ...r, deny })} mono placeholder="e.g. _adb-tls-connect._tcp" validate={isServiceType} ariaLabel="Denied service types" suggestions={Object.keys(MDNS_SERVICE_NAMES)} />
          <p className="mt-1.5 text-xs text-muted">Wins over Allow. Good for keeping debugging or file-sharing services private.</p>
        </div>
      </div>
      <p className="mt-2.5 text-xs text-muted">
        {r.to.length ? (
          <>Copies {r.allow.length ? r.allow.map((a) => MDNS_SERVICE_NAMES[a] ?? a).join(', ') : <Badge tone="warn">every service</Badge>} from <span className="font-mono">{r.from}</span> to <span className="font-mono">{r.to.join(', ')}</span>.</>
        ) : 'Pick at least one network to copy to.'}
      </p>
    </div>
  );
}
