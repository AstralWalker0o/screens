import { Ban, CircleArrowUp, CircleCheck, CircleDashed, CircleHelp, Cpu, KeyRound, Pin, Store, Bot, Bell, type LucideIcon } from 'lucide-react';
import type { RolloutDeviceStatus, RolloutStatus, UpdateBoxState, UpdateCheckResult, UpdateMode, UpdateRunResult } from '../../../shared/updates';
import { plural } from '../../lib/format';
import { STORE_INSTALLERS } from '../../../shared/updates';
import type { Tone } from '../../lib/labels';
import { fmtHm, localMinutes } from '../../../shared/updates';

export const STATE: Record<UpdateBoxState, { label: string; short: string; tone: Tone; icon: LucideIcon }> = {
  update: { label: 'Update ready', short: 'Update', tone: 'accent', icon: CircleArrowUp },
  current: { label: 'Up to date', short: 'Current', tone: 'ok', icon: CircleCheck },
  ahead: { label: 'Newer than Screens has', short: 'Newer', tone: 'ok', icon: CircleCheck },
  store: { label: 'Updated by Google Play', short: 'Play', tone: 'neutral', icon: Store },
  pinned: { label: 'Pinned', short: 'Pinned', tone: 'neutral', icon: Pin },
  incompatible: { label: 'No build for this box', short: 'No build', tone: 'warn', icon: Cpu },
  signer_mismatch: { label: 'Different signing key', short: 'Key differs', tone: 'crit', icon: KeyRound },
  no_source: { label: 'No update source', short: 'No source', tone: 'neutral', icon: CircleDashed },
  unknown: { label: 'Not read yet', short: 'Unknown', tone: 'neutral', icon: CircleHelp },
};

export const MODE: Record<UpdateMode, { label: string; icon: LucideIcon; help: string }> = {
  auto: { label: 'Auto', icon: Bot, help: 'Installs updates in the site’s maintenance window, one box first, skipping boxes in use.' },
  notify: { label: 'Notify', icon: Bell, help: 'Shows that an update is ready. You start it with one click.' },
  pin: { label: 'Pin', icon: Pin, help: 'Keeps the version the boxes have now.' },
};

export const ROLLOUT: Record<RolloutStatus, { label: string; tone: Tone }> = {
  canary: { label: 'Testing on one box', tone: 'accent' },
  rolling: { label: 'Updating', tone: 'accent' },
  done: { label: 'Finished', tone: 'ok' },
  failed: { label: 'Stopped', tone: 'crit' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const BOX_STEP: Record<RolloutDeviceStatus, { label: string; tone: Tone; icon: LucideIcon }> = {
  pending: { label: 'Queued', tone: 'neutral', icon: CircleDashed },
  installing: { label: 'Installing', tone: 'accent', icon: CircleArrowUp },
  verifying: { label: 'Checking', tone: 'accent', icon: CircleArrowUp },
  ok: { label: 'Updated', tone: 'ok', icon: CircleCheck },
  failed: { label: 'Failed', tone: 'crit', icon: Ban },
  skipped: { label: 'Skipped', tone: 'neutral', icon: CircleDashed },
  waiting: { label: 'Waiting', tone: 'warn', icon: CircleDashed },
};

export const installerLabel = (i?: string | null) => (i ? STORE_INSTALLERS[i] ?? (i === 'com.google.android.packageinstaller' ? 'Installed by hand' : i) : 'Sideloaded');

export const ABI_LABEL: Record<string, string> = {
  'arm64-v8a': '64-bit ARM', 'armeabi-v7a': '32-bit ARM', armeabi: 'Old 32-bit ARM', x86_64: '64-bit Intel', x86: '32-bit Intel', riscv64: 'RISC-V',
};
export const abiText = (a?: string | null) => (a ? `${ABI_LABEL[a] ?? a} (${a})` : 'unknown');

/** "03:00–05:00" plus what that is right now in the site's time zone. */
export function windowText(start: string, end: string) {
  return `${start}–${end}`;
}
export function siteClock(tz: string, at = Date.now()) {
  return fmtHm(localMinutes(at, tz));
}

export function checkMessage(results: UpdateCheckResult[]): string {
  if (!results.length) return 'No GitHub sources to check. Add one from an app’s settings.';
  const imported = results.flatMap((r) => r.imported.filter((i) => i.status === 'imported'));
  const failed = results.filter((r) => r.status === 'error' || r.status === 'rate_limited');
  const parts = [`Checked ${plural(results.length, 'source')}.`];
  parts.push(imported.length ? `Downloaded ${plural(imported.length, 'new build')}.` : 'No new releases.');
  if (failed.length) parts.push(`${plural(failed.length, 'source')} had a problem (see the app’s settings).`);
  return parts.join(' ');
}

export function runMessage(res: UpdateRunResult, label: string): string {
  const boxes = res.rollouts.reduce((a, r) => a + r.devices.length, 0);
  if (boxes === 1) return `Updating ${label} on ${res.rollouts[0].devices[0].name}.`;
  return `Updating ${label} on ${plural(boxes, 'box', 'boxes')}${res.rollouts.length > 1 ? ` at ${res.rollouts.length} sites` : ''}. One box goes first; follow along in Activity.`;
}
