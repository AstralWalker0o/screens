import { Gamepad2, MonitorSmartphone, LayoutGrid, Info, MessageSquare, HdmiPort, Tv, Cable, Radio, Camera, Play } from 'lucide-react';
import { useState } from 'react';
import type { Device } from '../../../shared/types';
import { sendCommand } from '../../lib/commands';
import { AppLauncher } from '../../components/AppLauncher';
import { Remote } from '../../components/Remote';
import { ScreenshotPane } from '../../components/Screenshot';
import { SonosControl } from '../../components/SonosControl';
import { MirrorPlayer } from '../../components/MirrorPlayer';
import { useLocalStorage } from '../../lib/hooks';
import { Button, Callout, Card, CardBody, CardHeader } from '../../components/ui';
import { Input, Segmented } from '../../components/forms';

export function ControlTab({ device: d }: { device: Device }) {
  const [mode, setMode] = useLocalStorage<'live' | 'shot'>('screen.mode', 'live');
  if (d.kind === 'sonos') return <SonosControl device={d} />;
  const hasScreen = d.capabilities.includes('screenshot');
  const canMirror = (d.capabilities as string[]).includes('mirror');
  const live = canMirror && mode === 'live' && d.status !== 'offline';
  return (
    <div className="space-y-4">
      {d.capabilities.includes('launch') && (
        <Card>
          <CardHeader title="Apps" icon={LayoutGrid} subtitle="Tap to open on the TV" />
          <CardBody className="pb-3">
            <AppLauncher device={d} />
          </CardBody>
        </Card>
      )}
      <div className={hasScreen ? 'grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]' : 'grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]'}>
        <Card>
          <CardHeader title="Remote" icon={Gamepad2} />
          <CardBody className="flex justify-center">
            {d.capabilities.includes('remote') ? <Remote device={d} /> : <p className="text-sm text-muted">This device can’t be controlled with remote keys.</p>}
          </CardBody>
        </Card>
        {hasScreen ? (
          <Card>
            <CardHeader
              title="Screen"
              icon={MonitorSmartphone}
              subtitle={live ? 'Live picture from the TV. Click to tap, scroll to scroll, type while it’s focused.' : 'See what’s on the TV. Click the picture to tap.'}
              actions={
                canMirror && (
                  <Segmented<'live' | 'shot'>
                    ariaLabel="Screen view"
                    size="sm"
                    value={live ? 'live' : 'shot'}
                    onChange={setMode}
                    options={[{ value: 'live', label: 'Live', icon: Radio }, { value: 'shot', label: 'Screenshot', icon: Camera }]}
                  />
                )
              }
            />
            <CardBody>
              {live ? <LiveView key={d.id} device={d} onUseScreenshots={() => setMode('shot')} /> : <ScreenshotPane device={d} />}
              {d.capabilities.includes('toast') && <ToastBox device={d} />}
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-4">
            <Callout kind="info" title={`What you can do with a ${d.kind === 'lg' ? 'LG' : 'Samsung'} TV`}>
              {d.kind === 'samsung' ? (
                <>
                  Samsung TVs let other devices press remote buttons, switch inputs, type text and open apps — that’s all. They don’t allow screenshots, installing or removing apps, or changing DNS settings over the network,
                  so those controls aren’t shown. To wake the TV from standby it needs <em>Power On with Mobile</em> turned on (see the Privacy checklist).
                </>
              ) : (
                <>LG TVs let other devices press remote buttons, type text, open apps and show messages on screen. Screenshots and app installs aren’t possible over the network.</>
              )}
            </Callout>
            {d.kind === 'samsung' && d.capabilities.includes('remote') && <InputPicker device={d} />}
            {d.capabilities.includes('toast') && (
              <Card>
                <CardHeader title="Show a message on the TV" icon={MessageSquare} />
                <CardBody><ToastBox device={d} bare /></CardBody>
              </Card>
            )}
            <Card>
              <CardHeader title="Now on screen" icon={Info} />
              <CardBody>
                <p className="text-sm text-fg">{d.current_app ?? (d.power === 'on' ? 'Home screen or live TV' : 'Screen is off')}</p>
                {typeof d.facts.art_mode === 'boolean' && d.facts.art_mode && <p className="mt-1 text-xs text-muted">Art mode is on — the screen shows artwork while “off”.</p>}
              </CardBody>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

const SOURCES: { id: string; label: string; icon: typeof Tv }[] = [
  { id: 'TV', label: 'TV', icon: Tv },
  { id: 'HDMI1', label: 'HDMI 1', icon: HdmiPort },
  { id: 'HDMI2', label: 'HDMI 2', icon: HdmiPort },
  { id: 'HDMI3', label: 'HDMI 3', icon: HdmiPort },
  { id: 'HDMI4', label: 'HDMI 4', icon: HdmiPort },
];

/** Samsung input switching (TV tuner or an HDMI port). */
function InputPicker({ device }: { device: Device }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const pick = async (source: string, label: string) => {
    setBusy(source);
    const r = await sendCommand(device.id, 'input', { source }, { success: source === 'SOURCE' ? 'Source menu opened on the TV' : `Switched to ${label}`, error: 'Couldn’t change the input' });
    setBusy(null);
    if (r && source !== 'SOURCE') setLast(source);
  };
  return (
    <Card>
      <CardHeader title="Input" icon={Cable} subtitle="Switch between the TV tuner and the HDMI ports (game console, set-top box…)." />
      <CardBody>
        <div className="flex flex-wrap gap-2" role="group" aria-label="TV input">
          {SOURCES.map((src) => (
            <Button
              key={src.id}
              icon={src.icon}
              loading={busy === src.id}
              disabled={device.status !== 'online' || (busy !== null && busy !== src.id)}
              variant={last === src.id ? 'soft' : 'secondary'}
              aria-pressed={last === src.id}
              onClick={() => pick(src.id, src.label)}
            >
              {src.label}
            </Button>
          ))}
          <Button variant="ghost" loading={busy === 'SOURCE'} disabled={device.status !== 'online' || (busy !== null && busy !== 'SOURCE')} onClick={() => pick('SOURCE', 'Source menu')}>Source menu…</Button>
        </div>
        <p className="mt-2 text-xs text-muted">The TV doesn’t report which input is active, so the highlighted one is just the last one you picked here.</p>
      </CardBody>
    </Card>
  );
}

function ToastBox({ device, bare }: { device: Device; bare?: boolean }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={bare ? 'flex gap-2' : 'mt-4 flex gap-2 border-t border-line pt-4'}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!msg.trim()) return;
        setBusy(true);
        const r = await sendCommand(device.id, 'toast', { message: msg.trim() }, { success: 'Message shown on the TV', invalidate: false });
        setBusy(false);
        if (r) setMsg('');
      }}
    >
      <Input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Pop up a message on the TV, e.g. “Checkout is at 11 am”" aria-label="Message to show on the TV" />
      <Button type="submit" loading={busy} disabled={!msg.trim()}>Show</Button>
    </form>
  );
}

/** The live view only connects (and starts the mirroring service on the box) after an explicit click. */
function LiveView({ device, onUseScreenshots }: { device: Device; onUseScreenshots: () => void }) {
  const [started, setStarted] = useState(false);
  if (started) return <MirrorPlayer device={device} onUseScreenshots={onUseScreenshots} />;
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-lg border border-line bg-black/90 px-6 text-center">
      <Button variant="primary" icon={Play} onClick={() => setStarted(true)}>Start live view</Button>
      <p className="max-w-sm text-xs text-white/70">Starts a live picture from {device.name}. Nothing runs on the box until you press this, and it stops when you leave the page.</p>
    </div>
  );
}
