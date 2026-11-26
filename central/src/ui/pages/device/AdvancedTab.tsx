import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { SquareTerminal, Save, Info, Link2, RefreshCw, RotateCw, Trash2, Eraser, Wrench, House, KeyRound } from 'lucide-react';
import { LauncherActions, LauncherStatusText } from '../../components/Launcher';
import type { Device } from '../../../shared/types';
import { api } from '../../api';
import { act, setQueryData } from '../../lib/query';
import { sendCommand } from '../../lib/commands';
import { fmtDate } from '../../lib/format';
import { kindLabel } from '../../lib/labels';
import { Badge, Button, Callout, Card, CardBody, CardHeader, KeyVal, cn } from '../../components/ui';
import { ChipsInput, Field, Input } from '../../components/forms';
import { ConfirmDialog } from '../../components/overlay';

export function AdvancedTab({ device: d }: { device: Device }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        {d.capabilities.includes('shell') && <ShellConsole device={d} />}
        <DetailsForm device={d} />
      </div>
      <div className="space-y-4">
        {d.capabilities.includes('launcher') && (
          <Card>
            <CardHeader title="Screens Launcher" icon={House} subtitle="Optional home screen with the guest welcome screen and kiosk mode. Its settings live on the site’s Guest tab." />
            <CardBody>
              <LauncherStatusText device={d} />
              <div className="mt-2"><LauncherActions device={d} /></div>
            </CardBody>
          </Card>
        )}
        {d.kind === 'android' && <PairWithCode device={d} />}
        <ActionsCard device={d} />
        <Card>
          <CardHeader title="About this device" icon={Info} />
          <CardBody>
            <KeyVal
              items={[
                ['Kind', kindLabel(d.kind, d.model)],
                ['Model', d.model],
                ['Maker', d.manufacturer],
                ['Software', d.os_version],
                ['Firmware', d.firmware],
                ['Serial', d.serial && <span className="font-mono text-[13px]">{d.serial}</span>],
                ['MAC address', d.mac && <span className="font-mono text-[13px]">{d.mac}</span>],
                ['Added', fmtDate(d.created_at)],
                ['Screens can', <span className="flex flex-wrap gap-1">{d.capabilities.map((c) => <Badge key={c} mono>{c}</Badge>)}{!d.capabilities.length && '–'}</span>],
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

const QUICK = [
  { label: 'Model', cmd: 'getprop ro.product.model' },
  { label: 'Android version', cmd: 'getprop ro.build.version.release' },
  { label: 'Private DNS', cmd: 'settings get global private_dns_mode' },
  { label: 'Third-party apps', cmd: 'pm list packages -3' },
  { label: 'Network', cmd: 'ip addr show' },
  { label: 'Storage', cmd: 'df -h /data' },
  { label: 'Uptime', cmd: 'uptime' },
];

interface Line { id: number; cmd: string; out: string; code: number | null }

function ShellConsole({ device }: { device: Device }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState<number | null>(null);
  const out = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  useEffect(() => {
    out.current?.scrollTo({ top: out.current.scrollHeight });
  }, [lines]);

  const run = async (c: string) => {
    const command = c.trim();
    if (!command || busy) return;
    setBusy(true);
    setHist((h) => [command, ...h.filter((x) => x !== command)].slice(0, 50));
    setHi(null);
    setCmd('');
    const id = seq.current++;
    setLines((l) => [...l, { id, cmd: command, out: '', code: null }]);
    const r = await sendCommand(device.id, 'shell', { cmd: command }, { invalidate: false, error: 'Shell command failed' });
    const data = (r?.data ?? {}) as { stdout?: string; stderr?: string; exit_code?: number };
    setLines((l) => l.map((x) => (x.id === id ? { ...x, out: r ? `${data.stdout ?? ''}${data.stderr ?? ''}` : 'Command failed — see the message above.', code: r ? data.exit_code ?? 0 : -1 } : x)));
    setBusy(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' && hist.length) {
      e.preventDefault();
      const n = hi == null ? 0 : Math.min(hist.length - 1, hi + 1);
      setHi(n);
      setCmd(hist[n]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hi == null) return;
      const n = hi - 1;
      setHi(n < 0 ? null : n);
      setCmd(n < 0 ? '' : hist[n]);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Shell"
        icon={SquareTerminal}
        subtitle="Run Android commands on the box (adb shell). For troubleshooting — you shouldn’t normally need this."
        actions={<Button size="sm" variant="ghost" icon={Eraser} onClick={() => setLines([])} disabled={!lines.length}>Clear</Button>}
      />
      <CardBody>
        <div className="mb-2 flex flex-wrap gap-1">
          {QUICK.map((q) => (
            <button key={q.cmd} type="button" onClick={() => run(q.cmd)} disabled={busy || device.status === 'offline'} title={q.cmd} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-50">
              {q.label}
            </button>
          ))}
        </div>
        <div ref={out} className="h-72 overflow-auto rounded-t-lg border border-b-0 border-line bg-[#0f1013] p-3 font-mono text-[12.5px] leading-relaxed text-[#d8dbe2]" aria-live="polite">
          {lines.length === 0 && <p className="text-[#8b8f99]">Type a command below, or pick one above. ↑ and ↓ go through your history.</p>}
          {lines.map((l) => (
            <div key={l.id} className="mb-2">
              <p><span className="text-[#6aabf1]">{device.name.toLowerCase().replace(/\s+/g, '-')}</span><span className="text-[#8b8f99]"> $ </span>{l.cmd}</p>
              {l.code === null ? <p className="text-[#8b8f99]">…</p> : <pre className={cn('break-words whitespace-pre-wrap', l.code !== 0 && 'text-[#f07272]')}>{l.out || '(no output)'}</pre>}
              {l.code !== null && l.code !== 0 && <p className="text-[11px] text-[#f07272]">exit code {l.code}</p>}
            </div>
          ))}
        </div>
        <form
          className="flex items-center gap-2 rounded-b-lg border border-line bg-[#0f1013] px-3 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(cmd);
          }}
        >
          <span className="font-mono text-sm text-[#8b8f99]" aria-hidden>$</span>
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={onKey}
            disabled={device.status === 'offline'}
            aria-label="Shell command"
            placeholder={device.status === 'offline' ? 'Device is offline' : 'getprop ro.product.model'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[#e8eaed] outline-none placeholder:text-[#5b5f69] focus-visible:outline-none"
          />
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!cmd.trim()}>Run</Button>
        </form>
      </CardBody>
    </Card>
  );
}

function DetailsForm({ device: d }: { device: Device }) {
  const init = () => ({ name: d.name, room: d.room ?? '', tags: d.tags, ip: d.ip ?? '', port: d.port != null ? String(d.port) : '' });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(init()), [d.id, d.updated_at]);
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  const ipErr = f.ip && !/^(\d{1,3}\.){3}\d{1,3}$/.test(f.ip) ? 'That isn’t an IPv4 address (example: 10.0.20.31)' : null;
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.devices.update(d.id, { name: f.name.trim(), room: f.room.trim() || null, tags: f.tags, ip: f.ip || null, port: f.port ? Number(f.port) : null }), {
      success: 'Device saved',
      invalidate: ['devices', `site:${d.site_id}`],
    });
    setBusy(false);
    if (r) setQueryData(`device:${d.id}`, () => r);
  };
  return (
    <Card>
      <CardHeader title="Name, room & address" icon={Wrench} />
      <CardBody>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (dirty && !ipErr) void save(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="dv-name"><Input id="dv-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Room" htmlFor="dv-room" optional><Input id="dv-room" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} /></Field>
          </div>
          <Field label="Tags" hint="Automations can target devices by tag, e.g. “guest” or “kids”.">
            <ChipsInput value={f.tags} onChange={(tags) => setF({ ...f, tags })} placeholder="Add a tag and press Enter" ariaLabel="Tags" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <Field label="IP address" htmlFor="dv-ip" error={ipErr} hint="Set a DHCP reservation on your router so this never changes.">
              <Input id="dv-ip" mono value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value.trim() })} />
            </Field>
            <Field label="Port" htmlFor="dv-port">
              <Input id="dv-port" mono inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, '') })} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            {dirty && <Button variant="ghost" onClick={() => setF(init())}>Discard</Button>}
            <Button type="submit" variant="primary" icon={Save} loading={busy} disabled={!dirty || !!ipErr || !f.name.trim()}>Save</Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function ActionsCard({ device: d }: { device: Device }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'reboot' | 'delete' | null>(null);
  const navigate = useNavigate();
  const run = async (cmd: string, success: string) => {
    setBusy(cmd);
    const r = await sendCommand(d.id, cmd, undefined, { success });
    setBusy(null);
    return r;
  };
  return (
    <Card>
      <CardHeader title="Maintenance" />
      <CardBody className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-fg">Re-pair</p>
            <p className="text-xs text-muted">
              {d.kind === 'android' ? 'Reconnects and shows “Allow USB debugging?” on the TV again.' : d.kind === 'sonos' ? 'Sonos doesn’t need pairing.' : 'Shows the “Allow” prompt on the TV again — use this if remote control stopped working.'}
            </p>
          </div>
          <Button size="sm" icon={Link2} loading={busy === 'pair'} disabled={d.kind === 'sonos' || d.kind === 'other'} onClick={() => run('pair', 'Look at the TV and choose Allow with its remote.')}>Re-pair</Button>
        </div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-fg">Refresh</p>
            <p className="text-xs text-muted">Re-read model, software version, power and the current app.</p>
          </div>
          <Button size="sm" icon={RefreshCw} loading={busy === 'refresh'} onClick={() => run('refresh', 'Device details refreshed')}>Refresh</Button>
        </div>
        {d.capabilities.includes('reboot') && (
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-fg">Restart</p>
              <p className="text-xs text-muted">Takes about a minute. Whatever is playing stops.</p>
            </div>
            <Button size="sm" icon={RotateCw} onClick={() => setConfirm('reboot')} disabled={d.status === 'offline'}>Restart</Button>
          </div>
        )}
        <div className="flex items-start justify-between gap-3 border-t border-line pt-4">
          <div>
            <p className="text-sm font-medium text-fg">Remove from Screens</p>
            <p className="text-xs text-muted">Stops filtering and controlling it. The device itself isn’t reset.</p>
          </div>
          <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => setConfirm('delete')}>Remove</Button>
        </div>
        {d.status === 'offline' && <Callout kind="tip">Most actions need the device to be online.</Callout>}
      </CardBody>
      <ConfirmDialog open={confirm === 'reboot'} onClose={() => setConfirm(null)} title={`Restart ${d.name}?`} confirmLabel="Restart" onConfirm={async () => { if (await run('reboot', `${d.name} is restarting`)) setConfirm(null); }}>
        <p>Anyone watching will be interrupted for about a minute.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        danger
        title={`Remove ${d.name}?`}
        confirmLabel="Remove device"
        typeToConfirm={d.name}
        onConfirm={async () => {
          const ok = await act(() => api.devices.remove(d.id), { success: `Removed ${d.name}`, invalidate: ['devices', `site:${d.site_id}`, 'sites', 'overview', `discovered:${d.site_id}`] });
          if (ok) navigate(`/sites/${d.site_id}`);
        }}
      >
        <p>Its history, privacy report and settings are deleted. You can adopt it again later from Discover.</p>
      </ConfirmDialog>
    </Card>
  );
}

/** Android 11+ / Google TV "Wireless debugging" pairing with a 6-digit code. */
function PairWithCode({ device }: { device: Device }) {
  const [code, setCode] = useState('');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const valid = /^\d{6}$/.test(code) && Number(port) > 0 && Number(port) < 65536;
  const submit = async () => {
    setBusy(true);
    setResult(null);
    const r = await sendCommand(device.id, 'adb_pair', { code, port: Number(port) }, { error: 'Pairing didn’t work', invalidate: [`device:${device.id}`, 'devices'] });
    setBusy(false);
    if (r) {
      setResult(((r.data as { detail?: string } | undefined)?.detail) ?? 'Paired.');
      setCode('');
      setPort('');
    }
  };
  return (
    <Card>
      <CardHeader title="Pair with code (Wireless debugging)" icon={KeyRound} />
      <CardBody>
        <p className="text-sm text-muted">
          On newer Google TV / Android 11+ boxes: Developer options → Wireless debugging → <em>Pair device with pairing code</em>. Enter the code and the port the TV shows.
          NVIDIA Shields use plain Network debugging and don’t need this.
        </p>
        <form className="mt-3 grid gap-3 sm:grid-cols-[1fr_120px_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (valid) void submit(); }}>
          <Field label="Pairing code" htmlFor="pair-code">
            <Input id="pair-code" mono inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          </Field>
          <Field label="Port" htmlFor="pair-port">
            <Input id="pair-port" mono inputMode="numeric" placeholder="37123" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
          </Field>
          <Button type="submit" variant="primary" icon={Link2} loading={busy} disabled={!valid || device.status === 'offline'}>Pair</Button>
        </form>
        <p className="mt-2 text-xs text-muted">The port here is the pairing port from the pop-up — it’s different from the one shown on the Wireless debugging screen itself.</p>
        {result && <p className="mt-2 text-sm text-ok-fg" role="status">{result}</p>}
      </CardBody>
    </Card>
  );
}
