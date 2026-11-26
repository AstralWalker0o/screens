// Screens Launcher over adb: STATUS, asset delivery through the app's ContentProvider, config broadcast.
// Contract: docs/LAUNCHER-V2.md (v2) and docs/LAUNCHER.md (v1).

import { ASSET_AUTHORITY, ASSET_EXTS, LAUNCHER_PACKAGE, SHA256_RE, supportsV2 } from '../../shared/launcher';
import type { LauncherState } from '../../shared/types';
import { b64Decode, sha256Hex, signAgentUrl } from '../lib/crypto';
import { parseJson } from '../lib/util';
import type { AdapterCtx } from './types';
import { AdapterError } from './types';

const PKG = LAUNCHER_PACKAGE;
const serialOf = (ctx: AdapterCtx) => `${ctx.device.ip}:${ctx.device.port || 5555}`;

async function sh(ctx: AdapterCtx, cmd: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  if (!ctx.device.ip) throw new AdapterError('bad_device', 'Device has no IP address');
  return ctx.gw('adb.shell', { serial: serialOf(ctx), cmd, timeout_ms: timeoutMs }, timeoutMs + 5_000);
}

/** Parse `am broadcast` output: Broadcast completed: result=1, data="ok:..." */
export function parseBroadcast(out: string): { result: number | null; data: string | null } {
  const m = out.match(/Broadcast completed: result=(-?\d+)(?:, data="((?:[^"\\]|\\.)*)")?/);
  return { result: m ? Number(m[1]) : null, data: m?.[2] != null ? m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null };
}

/** `content query` on the asset provider: one `Row: N sha256=<hex>, bytes=<n>` line per stored asset. */
export function parseAssetRows(out: string): { sha256: string; bytes: number | null }[] {
  const rows: { sha256: string; bytes: number | null }[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*Row:\s*\d+\s+(.*)$/);
    if (!m) continue;
    const sha = m[1].match(/(?:^|[\s,])sha256=([0-9a-fA-F]{64})(?=,|\s|$)/)?.[1]?.toLowerCase();
    const bytes = m[1].match(/(?:^|[\s,])bytes=(\d+)/)?.[1];
    if (sha) rows.push({ sha256: sha, bytes: bytes ? Number(bytes) : null });
  }
  return rows;
}

const shaList = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && SHA256_RE.test(s.toLowerCase())).map((s) => s.toLowerCase()) : undefined);

/** Fields from the app's `status:{…}` JSON (v1 has version/config_sha/is_home; v2 adds the rest). */
export function statusFields(st: Record<string, unknown>): Partial<LauncherState> {
  const out: Partial<LauncherState> = {
    version: typeof st.version === 'string' ? st.version : null,
    config_sha: typeof st.config_sha === 'string' ? st.config_sha : null,
    is_home: !!st.is_home,
  };
  if (typeof st.version_code === 'number') out.version_code = st.version_code;
  if (typeof st.config_v === 'number') out.config_v = st.config_v;
  const assets = shaList(st.assets);
  if (assets) out.assets = assets;
  const missing = shaList(st.missing_assets);
  if (missing) out.missing_assets = missing;
  if ('last_error' in st) out.last_error = typeof st.last_error === 'string' ? st.last_error.slice(0, 500) : null;
  return out;
}

const PUSH_FIELDS = ['pushed_at', 'pushed_sha', 'pushed_v', 'push_error', 'layout_id', 'assets_pushed'] as const;
function pushFields(ctx: AdapterCtx): Partial<LauncherState> {
  const prev = (parseJson<Record<string, any>>(ctx.device.facts, {}).launcher ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PUSH_FIELDS) if (k in prev) out[k] = prev[k];
  return out as Partial<LauncherState>;
}

/** Ask the app for its STATUS. Keeps what Screens recorded about its last push. */
export async function readLauncherStatus(ctx: AdapterCtx): Promise<LauncherState> {
  const r = await sh(ctx, `am broadcast --include-stopped-packages -a ${PKG}.STATUS -n ${PKG}/.ConfigReceiver`);
  const b = parseBroadcast(r.stdout);
  if (b.result === 1 && b.data?.startsWith('status:')) {
    return { ...pushFields(ctx), ...statusFields(parseJson<Record<string, unknown>>(b.data.slice(7), {})), installed: true, checked_at: Date.now() };
  }
  return { ...pushFields(ctx), installed: false, checked_at: Date.now() };
}

/** Assets the app holds, from its ContentProvider. */
export async function queryLauncherAssets(ctx: AdapterCtx): Promise<Set<string>> {
  const r = await sh(ctx, `content query --uri content://${ASSET_AUTHORITY}/ 2>&1`);
  return new Set(parseAssetRows(r.stdout).map((x) => x.sha256));
}

export interface PushAsset { sha256: string; ext: string; r2_key: string; bytes?: number }

/**
 * Deliver one image: gateway `adb.push` from a signed R2 URL (sha256-verified by the gateway) to
 * /data/local/tmp, then `content write` it into the app's provider (which re-verifies the SHA), then rm.
 */
export async function pushLauncherAsset(ctx: AdapterCtx, a: PushAsset): Promise<void> {
  if (!SHA256_RE.test(a.sha256) || !(ASSET_EXTS as readonly string[]).includes(a.ext)) throw new AdapterError('bad_args', 'Invalid launcher asset');
  const name = `${a.sha256}.${a.ext}`;
  const tmp = `/data/local/tmp/screens-asset-${name}`;
  const url = await signAgentUrl(ctx.env.SIGNING_SECRET, ctx.origin, 'GET', a.r2_key, 30 * 60_000);
  await ctx.gw('adb.push', { serial: serialOf(ctx), url, sha256: a.sha256, remote_path: tmp }, 180_000);
  const r = await sh(ctx, `content write --uri content://${ASSET_AUTHORITY}/${name} < ${tmp} 2>&1; echo "@@rc=$?"; rm -f ${tmp}`, 60_000);
  const rc = r.stdout.match(/@@rc=(\d+)/)?.[1];
  const out = r.stdout.replace(/@@rc=\d+\s*/, '').trim();
  if (rc !== '0' || /exception|error|denied|not found|unknown/i.test(out)) {
    throw new AdapterError('failed', `The launcher did not accept image ${a.sha256.slice(0, 12)}…: ${out.slice(-200) || `exit code ${rc ?? '?'}`}`);
  }
}

/** Send a config broadcast; the app answers `ok:<sha256 of the JSON>` or `error:<message>`. */
export async function sendLauncherConfig(ctx: AdapterCtx, configB64: string): Promise<{ ok: true; sha: string } | { ok: false; detail: string }> {
  if (!/^[A-Za-z0-9+/=]+$/.test(configB64) || configB64.length > 90_000) throw new AdapterError('bad_args', 'Invalid launcher config');
  const r = await sh(ctx, `am broadcast --include-stopped-packages -a ${PKG}.CONFIG -n ${PKG}/.ConfigReceiver --es config_b64 ${configB64}`);
  const b = parseBroadcast(r.stdout);
  if (b.result === 1 && b.data?.startsWith('ok:')) return { ok: true, sha: b.data.slice(3) };
  return { ok: false, detail: b.data ?? (r.stdout.trim().slice(-200) || 'No answer from the Screens Launcher (is it installed?)') };
}

/** What the hub hands the adapter for launcher_install / launcher_config (built by lib/launcher.ts). */
export interface LauncherApplyArgs {
  config_b64?: string;              // v1 config: every box understands it
  config_v2_b64?: string | null;    // v2 config (with home) when the box's layout exists
  v2_error?: string | null;         // why there is no v2 config (e.g. too large)
  assets?: PushAsset[];             // images the v2 config references
  layout_id?: string | null;
}

export interface LauncherApplyResult {
  ok: boolean;
  config_v: 1 | 2;
  sha?: string;
  expected_sha: string;
  detail?: string;
  assets_pushed: string[];
  assets_failed: { sha256: string; error: string }[];
}

/**
 * The push pipeline: read STATUS → (2.x only) copy every referenced image the box doesn't have →
 * send the config the installed version understands → record the outcome in facts.launcher.
 * 1.x boxes get the v1 config and no assets.
 */
export async function applyLauncherConfig(ctx: AdapterCtx, args: LauncherApplyArgs): Promise<LauncherApplyResult> {
  const st = await readLauncherStatus(ctx).catch(() => null);
  const v2Box = supportsV2(st);
  const v2 = v2Box && !!args.config_v2_b64;
  const pushed: string[] = [];
  const failed: { sha256: string; error: string }[] = [];
  if (v2Box && args.v2_error) {
    const detail = args.v2_error;
    await ctx.update({ facts: { launcher: { ...(st ?? { installed: true }), pushed_at: Date.now(), push_error: detail } } });
    return { ok: false, config_v: 2, expected_sha: '', detail, assets_pushed: [], assets_failed: [] };
  }
  if (v2 && args.assets?.length) {
    let have = st?.assets ? new Set(st.assets) : null;
    have ??= await queryLauncherAssets(ctx).catch(() => new Set<string>());
    for (const a of args.assets) {
      if (have.has(a.sha256)) continue;
      try {
        await pushLauncherAsset(ctx, a);
        pushed.push(a.sha256);
      } catch (e: any) {
        failed.push({ sha256: a.sha256, error: String(e?.message ?? e).slice(0, 300) });
      }
    }
  }
  const b64 = v2 ? args.config_v2_b64! : String(args.config_b64 ?? '');
  const expected = await sha256Hex(b64Decode(b64));
  const cfg = await sendLauncherConfig(ctx, b64);
  const mismatch = cfg.ok && cfg.sha !== expected;
  const push_error = !cfg.ok ? cfg.detail
    : mismatch ? `The launcher stored a different config than Screens sent (${cfg.sha.slice(0, 12)}… instead of ${expected.slice(0, 12)}…)`
      : failed.length ? `${failed.length} image${failed.length === 1 ? '' : 's'} could not be copied to the box: ${failed[0].error}` : null;
  await ctx.update({
    facts: {
      launcher: {
        ...(st ?? { installed: cfg.ok }), pushed_at: Date.now(), pushed_sha: expected, pushed_v: v2 ? 2 : 1, push_error,
        layout_id: v2 ? args.layout_id ?? null : null, assets_pushed: pushed.length,
      },
    },
  });
  return {
    ok: cfg.ok && !mismatch && !failed.length, config_v: v2 ? 2 : 1, sha: cfg.ok ? cfg.sha : undefined, expected_sha: expected,
    detail: push_error ?? undefined, assets_pushed: pushed, assets_failed: failed,
  };
}
