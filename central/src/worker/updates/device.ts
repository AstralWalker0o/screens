// adb shell commands the update manager sends to Android TV boxes, and pure parsers for their output.
// Every command starts with an `@@upd=<name>` marker line so logs (and the e2e simulator) can tell them apart.
// Package names are validated before they reach a command; nothing else from outside is interpolated.

import type { ApkSigning } from '../../shared/updates';
import { b64Decode } from '../lib/crypto';
import { assertPackage, shellQuote } from '../lib/util';
import { ApkError, findEocd, signingFromTail, type RandomAccess } from './apk';

export type Shell = (cmd: string, timeoutMs?: number) => Promise<{ stdout: string; exit_code?: number }>;

/** Parse "@@key=value" marker lines (first occurrence wins). */
export function markers(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^@@([a-z0-9_]+)=(.*)$/);
    if (m && !(m[1] in r)) r[m[1]] = m[2].trim();
  }
  return r;
}

// ---------------------------------------------------------------------------------------------- inventory probe

/** Processor ABIs, Android version, and per sideloaded app: version, installer and dumpsys signature hashes. */
export const PROBE_CMD = [
  'echo @@upd=probe',
  'echo "@@abi=$(getprop ro.product.cpu.abi)"',
  'echo "@@abilist=$(getprop ro.product.cpu.abilist)"',
  'echo "@@sdk=$(getprop ro.build.version.sdk)"',
  'echo @@PKGS',
  "for p in $(pm list packages -3 | cut -d: -f2); do echo \"$p|$(dumpsys package $p | grep -oE 'versionCode=[0-9]+|installerPackageName=[^ ]+|PackageSignatures\\{[^}]*\\}' | tr '\\n' '|')\"; done",
  'echo @@END',
].join('; ');

export interface ProbeApp { version_code: number | null; installer: string | null; sig_hashes: string[] }
export interface ProbeResult { abis: string[]; sdk: number | null; apps: Map<string, ProbeApp> }

/** `signatures=PackageSignatures{9f2c1a0 version:2, signatures:[4c2f8a1b], past signatures:[]}` (Android 9+), `{9f2c1a0 [4c2f8a1b]}` (older). */
export function parseSigHashes(s: string): string[] {
  const m = s.match(/PackageSignatures\{[0-9a-f]+ (?:version:\d+, )?(?:signatures:)?\[([0-9a-f, ]*)\]/i);
  return m ? m[1].split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[0-9a-f]{1,8}$/.test(x)) : [];
}

export function parseProbe(out: string): ProbeResult {
  const m = markers(out);
  const list = (m.abilist || m.abi || '').split(',').map((x) => x.trim()).filter((x) => /^[a-z0-9_-]+$/i.test(x));
  const primary = /^[a-z0-9_-]+$/i.test(m.abi ?? '') ? m.abi : null;
  const abis = primary ? [primary, ...list.filter((a) => a !== primary)] : list;
  const apps = new Map<string, ProbeApp>();
  let inPkgs = false;
  for (const line of out.split('\n')) {
    const l = line.trim();
    if (l === '@@PKGS') { inPkgs = true; continue; }
    if (l === '@@END') break;
    if (!inPkgs || !l) continue;
    const [pkg, ...rest] = l.split('|');
    if (!/^[A-Za-z][\w]*(\.[\w]+)+$/.test(pkg)) continue;
    const body = rest.join('|');
    const vc = body.match(/versionCode=(\d+)/);
    const inst = body.match(/installerPackageName=([^|\s]+)/);
    apps.set(pkg, {
      version_code: vc ? Number(vc[1]) : null,
      installer: inst && inst[1] !== 'null' ? inst[1] : null,
      sig_hashes: parseSigHashes(body),
    });
  }
  return { abis, sdk: Number(m.sdk) || null, apps };
}

// ---------------------------------------------------------------------------------------------- right before installing

/** Live version / installer of one package and whether someone is using the box. */
export function preflightCmd(pkg: string): string {
  const p = assertPackage(pkg);
  return [
    'echo @@upd=pre',
    `echo "@@present=$(pm list packages ${p} | grep -cx 'package:${p}')"`,
    `echo "@@vc=$(dumpsys package ${p} | grep -m1 -oE 'versionCode=[0-9]+' | cut -d= -f2)"`,
    `echo "@@installer=$(dumpsys package ${p} | grep -m1 -oE 'installerPackageName=[^ ]+' | cut -d= -f2)"`,
    `echo "@@sigs=$(dumpsys package ${p} | grep -m1 -oE 'PackageSignatures\\{[^}]*\\}')"`,
    'echo "@@wake=$(dumpsys power | grep -m1 -oE \'mWakefulness=[A-Za-z]+\' | cut -d= -f2)"',
    'echo "@@resumed=$(dumpsys activity activities | grep -m1 -E \'mResumedActivity|topResumedActivity\')"',
    'echo "@@home=$(cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tail -n 1)"',
    "echo \"@@playing=$(dumpsys media_session 2>/dev/null | grep -c 'PlaybackState {state=3,')\"",
  ].join('; ');
}

export interface Preflight {
  present: boolean; version_code: number | null; installer: string | null; sig_hashes: string[];
  awake: boolean; foreground: string | null; home: string | null; playing: boolean;
}

/** Package of the resumed activity: "mResumedActivity: ActivityRecord{1a2b u0 com.foo/.Main t42}". */
export function resumedPackage(line: string): string | null {
  const m = (line ?? '').match(/\s(?:u\d+\s)?([a-zA-Z][\w.]*)\/[\w.$]+/);
  return m ? m[1] : null;
}

export function parsePreflight(out: string): Preflight {
  const m = markers(out);
  const home = (m.home ?? '').match(/^([a-zA-Z][\w.]*)\//)?.[1] ?? null;
  return {
    present: m.present === '1',
    version_code: /^\d+$/.test(m.vc ?? '') ? Number(m.vc) : null,
    installer: m.installer && m.installer !== 'null' ? m.installer : null,
    sig_hashes: parseSigHashes(m.sigs ?? ''),
    awake: m.wake === 'Awake',
    foreground: resumedPackage(m.resumed ?? ''),
    home,
    playing: Number(m.playing) > 0,
  };
}

export const KNOWN_LAUNCHERS = ['com.google.android.tvlauncher', 'com.google.android.apps.tv.launcherx', 'au.supercluster.screens.launcher', 'com.spocky.projengmenu', 'com.amazon.tv.launcher', 'com.nvidia.shield.launcher'];

/** Someone is watching: media is playing, or the screen is on with an app (not the home screen) in front. */
export function busyReason(p: Preflight): string | null {
  if (p.playing) return 'Something is playing on this box';
  const launchers = new Set([...KNOWN_LAUNCHERS, ...(p.home ? [p.home] : [])]);
  if (p.awake && p.foreground && !launchers.has(p.foreground)) return `The TV is on and ${p.foreground} is open`;
  return null;
}

// ---------------------------------------------------------------------------------------------- after installing

export const versionCmd = (pkg: string) => `echo @@upd=ver; echo "@@vc=$(dumpsys package ${assertPackage(pkg)} | grep -m1 -oE 'versionCode=[0-9]+' | cut -d= -f2)"`;

/**
 * Open the app the way a person would (Leanback launcher icon, else phone launcher icon), wait, see whether it
 * is in front / running / crashed, then bring the home screen back with an intent (a HOME key press would wake a
 * sleeping box, and with HDMI-CEC the TV too).
 */
export function launchCheckCmd(pkg: string): string {
  const p = assertPackage(pkg);
  return [
    'echo @@upd=launch',
    `echo "@@crash0=$(logcat -b crash -d 2>/dev/null | grep -c 'Process: ${p},')"`,
    `if monkey -p ${p} -c android.intent.category.LEANBACK_LAUNCHER 1 2>&1 | grep -q 'No activities'; then if monkey -p ${p} -c android.intent.category.LAUNCHER 1 2>&1 | grep -q 'No activities'; then echo "@@nolaunch=1"; fi; fi`,
    'sleep 5',
    `echo "@@pid=$(pidof ${p})"`,
    'echo "@@resumed=$(dumpsys activity activities | grep -m1 -E \'mResumedActivity|topResumedActivity\')"',
    `echo "@@crash1=$(logcat -b crash -d 2>/dev/null | grep -c 'Process: ${p},')"`,
    'am start -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null 2>&1',
    'echo @@done=1',
  ].join('; ');
}

export function launchVerdict(out: string, pkg: string, awake: boolean): { ok: boolean; detail: string } {
  const m = markers(out);
  if (m.nolaunch === '1') return { ok: true, detail: 'The app has no launcher icon, so Screens didn’t open it.' };
  if (Number(m.crash1) > Number(m.crash0)) return { ok: false, detail: 'The app crashed when it was opened after the update.' };
  const fg = resumedPackage(m.resumed ?? '');
  const running = /^\d+/.test(m.pid ?? '');
  if (fg === pkg) return { ok: true, detail: 'Opened and came to the front.' };
  if (running) return { ok: true, detail: awake ? `Started (the screen showed ${fg ?? 'something else'} in front).` : 'The box was asleep: the app started without crashing.' };
  return { ok: false, detail: 'The app didn’t start after the update.' };
}

// ---------------------------------------------------------------------------------------------- installed signer (strong)

const APK_PATH_RE = /^\/data\/app\/[A-Za-z0-9._~=+\-/]+\/base\.apk$/;
const CHUNK = 192 * 1024; // raw bytes per read: base64 stays well under the gateway's 512 KB frame

/**
 * Read the signing certificate of the copy installed on the box: the APK Signing Block sits just before the ZIP
 * central directory, so only the end of base.apk is pulled (base64 over adb shell), never the whole app.
 * Returns null when the box can't do it (old toybox without base64, JAR-only signature) — callers fall back to
 * the dumpsys hash.
 */
export async function installedSigning(sh: Shell, pkg: string): Promise<ApkSigning | null> {
  const p = assertPackage(pkg);
  const first = markers((await sh([
    'echo @@upd=apktail',
    `f=$(pm path ${p} 2>/dev/null | grep -m1 'base.apk' | cut -d: -f2)`,
    'echo "@@path=$f"',
    'echo "@@size=$(stat -c %s "$f" 2>/dev/null)"',
    `echo "@@b64=$(tail -c ${CHUNK} "$f" 2>/dev/null | base64 -w 0 2>/dev/null)"`,
  ].join('; '), 30_000)).stdout);
  const path = first.path ?? '', size = Number(first.size);
  if (!APK_PATH_RE.test(path) || !(size > 22) || !first.b64) return null;
  let tail: Uint8Array;
  try { tail = b64Decode(first.b64); } catch { return null; }
  if (tail.length !== Math.min(size, CHUNK)) return null;
  const tailStart = size - tail.length;
  let reads = 0;
  const r: RandomAccess = {
    size,
    async read(o, l) {
      if (o >= tailStart && o + l <= size) return tail.subarray(o - tailStart, o - tailStart + l);
      if (++reads > 8 || l > CHUNK || o < 0) throw new ApkError('Signing block too large to read from the box');
      const out = markers((await sh(`echo @@upd=apkpart; echo "@@b64=$(tail -c +${o + 1} ${shellQuote(path)} 2>/dev/null | head -c ${l} | base64 -w 0 2>/dev/null)"`, 30_000)).stdout);
      const b = b64Decode(out.b64 ?? '');
      if (b.length !== l) throw new ApkError('Short read from the box');
      return b;
    },
  };
  try {
    findEocd(tail.subarray(Math.max(0, tail.length - 65557)), size);
    return await signingFromTail(r);
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------- install errors

/** Turn Android's install failure codes into something the owner can act on. */
export function installErrorText(raw: string): string {
  const s = String(raw ?? '');
  const code = s.match(/INSTALL_[A-Z_]+/)?.[0];
  const map: Record<string, string> = {
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Android refused it: the new build is signed with a different key than the installed app. Screens never uninstalls to force an update.',
    INSTALL_FAILED_VERSION_DOWNGRADE: 'Android refused it because it is older than the installed version. Screens never downgrades.',
    INSTALL_FAILED_INSUFFICIENT_STORAGE: 'The box is out of storage space. Free some space and try again.',
    INSTALL_FAILED_OLDER_SDK: 'This build needs a newer Android version than the box has.',
    INSTALL_FAILED_NO_MATCHING_ABIS: 'This build isn’t made for the box’s processor. Pick a different build (ABI) for this box.',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES: 'The APK isn’t signed properly, so Android refused it.',
    INSTALL_FAILED_INVALID_APK: 'Android says the APK file is broken.',
    INSTALL_FAILED_USER_RESTRICTED: 'The box blocked installs over USB/network debugging. Turn on "Install via USB" (or "Verify apps over USB" off) in Developer options.',
    INSTALL_FAILED_VERIFICATION_FAILURE: 'Google Play Protect blocked the install on the box.',
  };
  if (code && map[code]) return map[code];
  if (/sha-?256|checksum|digest/i.test(s)) return 'The downloaded file didn’t match its checksum, so the gateway refused to install it.';
  if (/timeout|did not answer/i.test(s)) return 'The install took too long. The box may be busy or the network slow.';
  return (code ? `Android said ${code}. ` : '') + s.replace(/\s+/g, ' ').trim().slice(0, 300);
}
