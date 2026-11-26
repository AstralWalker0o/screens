import { Gamepad2, MonitorSmartphone, LayoutGrid, Info, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import type { Device } from '../../../shared/types';
import { sendCommand } from '../../lib/commands';
import { AppLauncher } from '../../components/AppLauncher';
import { Remote } from '../../components/Remote';
import { ScreenshotPane } from '../../components/Screenshot';
import { SonosControl } from '../../components/SonosControl';
import { Button, Callout, Card, CardBody, CardHeader } from '../../components/ui';
import { Input } from '../../components/forms';

export function ControlTab({ device: d }: { device: Device }) {
  if (d.kind === 'sonos') return <SonosControl device={d} />;
  const hasScreen = d.capabilities.includes('screenshot');
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
            <CardHeader title="Screen" icon={MonitorSmartphone} subtitle="See what’s on the TV. Click the picture to tap." />
            <CardBody>
              <ScreenshotPane device={d} />
              {d.capabilities.includes('toast') && <ToastBox device={d} />}
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-4">
            <Callout kind="info" title={`What you can do with a ${d.kind === 'lg' ? 'LG' : 'Samsung'} TV`}>
              {d.kind === 'samsung' ? (
                <>
                  Samsung TVs let other devices press remote buttons, type text and open apps — that’s all. They don’t allow screenshots, installing or removing apps, or changing DNS settings over the network,
                  so those controls aren’t shown. To wake the TV from standby it needs <em>Power On with Mobile</em> turned on (see the Privacy checklist).
                </>
              ) : (
                <>LG TVs let other devices press remote buttons, type text, open apps and show messages on screen. Screenshots and app installs aren’t possible over the network.</>
              )}
            </Callout>
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
