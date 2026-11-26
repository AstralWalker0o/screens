import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ShieldCheck, ScanEye, ShieldAlert, Sparkles, ChevronDown, Ban, Check, Eye, Tv, ListChecks, Globe } from 'lucide-react';
import type { DnsCategory, DnsDomainStat, PrivacyOverview } from '../../shared/types';
import { api } from '../api';
import { act, setQueryData, useQuery } from '../lib/query';
import { fmtCompact, fmtNum, fmtPct } from '../lib/format';
import { CATEGORY } from '../lib/labels';
import { useLocalStorage, useElementWidth } from '../lib/hooks';
import { ChartFrame, KpiTile, LegendItem } from '../components/charts';
import { PrivacyRankRow } from '../components/rows';
import { CategoryBadge } from '../components/status';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, RelTime, SkeletonRows, TableWrap, cn, td, th } from '../components/ui';
import { Select } from '../components/forms';

export default function Privacy() {
  const q = useQuery('privacy-overview', api.privacy, { refreshMs: 60_000 });
  const p = q.data;
  const acrTotal = p?.acr_by_vendor.reduce((a, v) => a + v.attempts, 0) ?? 0;
  const acrBlocked = p?.acr_by_vendor.reduce((a, v) => a + v.blocked, 0) ?? 0;
  const poor = p?.devices.filter((d) => d.grade === 'D' || d.grade === 'F').length ?? 0;
  const bypass = p?.devices.filter((d) => d.bypass_suspected).length ?? 0;

  return (
    <>
      <PageHeader title="Privacy" subtitle="Which devices are spying, who they report to, and what Screens is doing about it." />
      <AcrExplainer />

      <section aria-label="Key numbers" className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile loading={q.loading} icon={ScanEye} label="ACR attempts · 7 d" value={p && fmtCompact(acrTotal)} sub={p && `${fmtPct(acrBlocked, acrTotal)} blocked`} />
        <KpiTile loading={q.loading} icon={ShieldAlert} label="Graded D or F" value={p && poor} sub={p && `of ${p.devices.length} scored devices`} />
        <KpiTile loading={q.loading} icon={ShieldAlert} label="Bypassing DNS?" value={p && bypass} sub={p && (bypass ? 'Turn on Private DNS for them' : 'None — good')} />
        <KpiTile loading={q.loading} icon={Sparkles} label="New domains · 7 d" value={p && p.new_domains.length} sub="First contacted this week" />
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Devices ranked by privacy" icon={ShieldCheck} subtitle="Worst first. Open a device for its checklist and what it’s contacting." />
          <CardBody>
            {q.loading ? <SkeletonRows rows={6} /> : p!.devices.length ? (
              <ul className="divide-y divide-line">{p!.devices.map((r, i) => <PrivacyRankRow key={r.device_id} row={r} rank={i + 1} />)}</ul>
            ) : (
              <EmptyState icon={ShieldCheck} title="No scores yet">Devices get a grade once they’re adopted and Screens has watched their traffic for a little while.</EmptyState>
            )}
          </CardBody>
        </Card>
        {q.loading ? <Card className="p-4"><SkeletonRows rows={5} /></Card> : <AcrVendorChart rows={p!.acr_by_vendor} />}
      </section>

      <NewDomains p={p} loading={q.loading} />
    </>
  );
}

function AcrExplainer() {
  const [open, setOpen] = useLocalStorage('privacy.explainer.open', true);
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-fg"><Tv className="size-[18px]" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-fg">What is ACR, and why block it?</span>
          <span className="block text-xs text-muted">Automatic content recognition: how smart TVs watch what you watch.</span>
        </span>
        <ChevronDown className={cn('size-4 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="grid gap-5 border-t border-line px-4 py-4 text-sm text-muted md:grid-cols-3">
          <div>
            <p className="mb-1 flex items-center gap-1.5 font-medium text-fg"><ScanEye className="size-4" aria-hidden />What it does</p>
            <p>
              Several times a second the TV takes a tiny fingerprint of whatever is on screen — live TV, streaming apps, even a games console or laptop plugged into HDMI — and sends it to the manufacturer or an ad company.
              They match it to work out exactly what you watch and when, then use it to target ads on your TV, phone and computer.
            </p>
          </div>
          <div>
            <p className="mb-1 flex items-center gap-1.5 font-medium text-fg"><Eye className="size-4" aria-hidden />Who does it</p>
            <p>
              Samsung calls it <em>Viewing Information Services</em>, LG <em>Live Plus</em> (powered by Alphonso), Vizio <em>Viewing Data</em> (Inscape), and Samba TV builds it into many brands and apps.
              It’s usually switched on when you accept the TV’s terms during setup.
            </p>
          </div>
          <div>
            <p className="mb-1 flex items-center gap-1.5 font-medium text-fg"><ShieldCheck className="size-4" aria-hidden />What Screens does</p>
            <ul className="space-y-1">
              <li className="flex gap-1.5"><Ban className="mt-0.5 size-3.5 shrink-0" aria-hidden />Blocks the servers the fingerprints are sent to, at every site.</li>
              <li className="flex gap-1.5"><ListChecks className="mt-0.5 size-3.5 shrink-0" aria-hidden />Gives a checklist per TV to switch it off in the TV’s own settings — do this too, as TVs retry and change servers.</li>
              <li className="flex gap-1.5"><Globe className="mt-0.5 size-3.5 shrink-0" aria-hidden />Flags new tracking domains as soon as a device first contacts them.</li>
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}

/** One horizontal bar per vendor; the blocked share is a segment inside the bar. */
function AcrVendorChart({ rows }: { rows: PrivacyOverview['acr_by_vendor'] }) {
  const [ref, width] = useElementWidth<HTMLUListElement>();
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.attempts));
  return (
    <ChartFrame
      title="ACR attempts by vendor"
      icon={ScanEye}
      subtitle="Content-recognition lookups in the last 7 days, and how many were blocked"
      legend={
        <>
          <LegendItem color="var(--color-crit)" label="Blocked" />
          <LegendItem color="var(--color-warn)" label="Not blocked (device in monitor mode, or allowed)" />
        </>
      }
      table={
        <table className="w-full text-sm">
          <thead className="bg-surface-2"><tr><th className={th}>Vendor</th><th className={cn(th, 'text-right')}>Attempts</th><th className={cn(th, 'text-right')}>Blocked</th><th className={cn(th, 'text-right')}>Devices</th></tr></thead>
          <tbody className="divide-y divide-line tnum">
            {rows.map((r) => (
              <tr key={r.vendor}><td className={cn(td, 'py-1.5')}>{r.vendor}</td><td className={cn(td, 'py-1.5 text-right')}>{fmtNum(r.attempts)}</td><td className={cn(td, 'py-1.5 text-right')}>{fmtNum(r.blocked)} ({fmtPct(r.blocked, r.attempts)})</td><td className={cn(td, 'py-1.5 text-right')}>{r.devices}</td></tr>
            ))}
          </tbody>
        </table>
      }
    >
      {rows.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No ACR seen this week" className="py-8">None of your devices tried to report what’s on screen.</EmptyState>
      ) : (
        <ul ref={ref} className="space-y-4 pt-1 pb-1">
          {rows.map((r) => {
            const total = width ? (r.attempts / max) * Math.max(0, width - 104) : 0;
            const blockedW = r.attempts ? (r.blocked / r.attempts) * total : 0;
            const restW = Math.max(0, total - blockedW - (r.blocked && r.blocked < r.attempts ? 2 : 0));
            const share = fmtPct(r.blocked, r.attempts, 0);
            const inside = `${share} blocked`;
            const fits = blockedW >= inside.length * 6.6 + 14;
            const fitsShort = !fits && blockedW >= share.length * 7 + 12;
            return (
              <li
                key={r.vendor}
                tabIndex={0}
                onPointerEnter={() => setHover(r.vendor)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(r.vendor)}
                onBlur={() => setHover(null)}
                aria-label={`${r.vendor}: ${fmtNum(r.attempts)} attempts from ${r.devices} device${r.devices === 1 ? '' : 's'}, ${share} blocked`}
                className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-fg">{r.vendor}</span>
                  <span className="text-xs text-muted tnum">
                    <span className="font-semibold text-fg">{fmtNum(r.attempts)}</span> attempts · {r.devices} device{r.devices === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="relative flex h-6 items-stretch" style={{ opacity: hover && hover !== r.vendor ? 0.55 : 1, transition: 'opacity 120ms' }}>
                  {blockedW > 0 && (
                    <div
                      className={cn('chart-mark flex items-center overflow-hidden px-2 text-xs font-semibold text-white', restW > 0 ? 'rounded-none' : 'rounded-r-[4px]')}
                      style={{ width: blockedW, background: 'var(--color-crit)' }}
                    >
                      {fits ? inside : fitsShort ? share : ''}
                    </div>
                  )}
                  {restW > 0 && (
                    <div className="chart-mark rounded-r-[4px]" style={{ width: restW, marginLeft: blockedW > 0 ? 2 : 0, background: 'var(--color-warn)' }} />
                  )}
                  {!fits && !fitsShort && <span className="ml-2 self-center text-xs text-muted">{share} blocked</span>}
                </div>
                {hover === r.vendor && (
                  <p className="mt-1 text-xs text-muted tnum">
                    {fmtNum(r.blocked)} blocked · {fmtNum(r.attempts - r.blocked)} not blocked
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rows.some((r) => r.blocked < r.attempts) && (
        <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
          “Not blocked” usually means the TV is still in <strong className="text-fg">Monitor</strong> mode — Screens is only recording its ACR traffic until monitoring ends, then blocks it automatically.
          To stop it sooner, switch the device to Enforce on its Network tab.
        </p>
      )}
    </ChartFrame>
  );
}

function NewDomains({ p, loading }: { p?: PrivacyOverview; loading: boolean }) {
  const [cat, setCat] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const list = useMemo(() => (p?.new_domains ?? []).filter((d) => !cat || d.category === cat), [p, cat]);
  const cats = Array.from(new Set((p?.new_domains ?? []).map((d) => d.category).filter(Boolean))) as DnsCategory[];
  const rule = async (d: DnsDomainStat, action: 'block' | 'allow') => {
    setBusy(`${d.domain}:${action}`);
    const r = await act(
      () => api.dns.addRule({ domain: d.domain, action, category: d.category ?? null, vendor: d.vendor ?? null, policies: action === 'block' ? ['balanced', 'strict'] : ['balanced', 'strict', 'monitor'], scope_type: 'global', scope_id: '', notes: 'From Privacy → new domains' }),
      { success: `${action === 'block' ? 'Blocking' : 'Allowing'} ${d.domain} everywhere`, invalidate: ['rules', 'dns-'] },
    );
    setBusy(null);
    if (r) setQueryData<PrivacyOverview>('privacy-overview', (old) => old && { ...old, new_domains: old.new_domains.map((x) => (x.domain === d.domain ? { ...x, rule: action } : x)) });
  };
  return (
    <Card className="mt-4">
      <CardHeader
        title="Newly seen domains"
        icon={Sparkles}
        subtitle="Domains a device contacted for the first time in the last 7 days. New tracking servers often show up here first."
        actions={
          <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="w-40">
            <option value="">All categories</option>
            {cats.map((c) => <option key={c} value={c}>{CATEGORY[c].label}</option>)}
          </Select>
        }
      />
      {loading ? (
        <CardBody><SkeletonRows rows={5} /></CardBody>
      ) : list.length === 0 ? (
        <CardBody><p className="py-6 text-center text-sm text-muted">Nothing new this week.</p></CardBody>
      ) : (
        <>
          <TableWrap className="hidden md:block">
            <table className="w-full text-sm">
              <thead className="border-y border-line bg-surface-2/60">
                <tr><th className={th}>Domain</th><th className={th}>Category</th><th className={th}>Vendor</th><th className={cn(th, 'text-right')}>Devices</th><th className={cn(th, 'text-right')}>Lookups</th><th className={th}>First seen</th><th className={cn(th, 'text-right')}>Action</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((d) => (
                  <tr key={d.domain}>
                    <td className={cn(td, 'font-mono text-[12.5px]')}><Link to={`/dns/domains?q=${encodeURIComponent(d.domain)}`} className="hover:underline">{d.domain}</Link></td>
                    <td className={td}><CategoryBadge cat={d.category} /></td>
                    <td className={cn(td, 'text-muted')}>{d.vendor ?? '–'}</td>
                    <td className={cn(td, 'text-right tnum')}>{d.devices ?? '–'}</td>
                    <td className={cn(td, 'text-right tnum')}>{fmtNum(d.queries)}</td>
                    <td className={cn(td, 'text-xs text-muted')}><RelTime ts={d.first_seen} /></td>
                    <td className={cn(td, 'text-right')}><RuleButtons d={d} busy={busy} onRule={rule} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <ul className="divide-y divide-line border-t border-line md:hidden">
            {list.map((d) => (
              <li key={d.domain} className="px-4 py-3">
                <p className="font-mono text-[12.5px] break-all text-fg">{d.domain}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <CategoryBadge cat={d.category} />
                  {d.vendor && <span>{d.vendor}</span>}
                  <span>{fmtNum(d.queries)} lookups</span>
                  <span>· first <RelTime ts={d.first_seen} /></span>
                </div>
                <div className="mt-2"><RuleButtons d={d} busy={busy} onRule={rule} /></div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function RuleButtons({ d, busy, onRule }: { d: DnsDomainStat; busy: string | null; onRule: (d: DnsDomainStat, a: 'block' | 'allow') => void }) {
  if (d.rule === 'block') return <Badge tone="crit" icon={Ban}>Blocked by you</Badge>;
  if (d.rule === 'allow') return <Badge tone="ok" icon={Check}>Allowed by you</Badge>;
  return (
    <span className="inline-flex gap-1.5">
      <Button size="xs" variant="secondary" icon={Ban} loading={busy === `${d.domain}:block`} onClick={() => onRule(d, 'block')}>Block</Button>
      <Button size="xs" variant="ghost" icon={Check} loading={busy === `${d.domain}:allow`} onClick={() => onRule(d, 'allow')}>Allow</Button>
    </span>
  );
}
