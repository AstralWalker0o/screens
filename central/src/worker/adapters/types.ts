import type { Env } from '../env';
import type { Row } from '../lib/db';

/** A relay stream (ws.open / tcp.open) through the site gateway. */
export interface HubStream {
  id: string;
  send(text: string): void;
  sendBinary(b64: string): void;
  /** Wait for the next text message matching `pred` (default: any). Rejects on timeout or close. */
  next(pred?: (msg: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): void;
  readonly closed: boolean;
}

export interface AdapterCtx {
  env: Env;
  device: Row;                 // raw devices row
  origin: string;              // public origin for signed URLs
  gw<T = any>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  openWs(url: string, opts?: { headers?: Record<string, string>; insecure_tls?: boolean }): Promise<HubStream>;
  getSecrets<T extends object>(): Promise<T>;
  setSecrets(v: object): Promise<void>;
  update(fields: Record<string, unknown>): Promise<void>;     // persist device fields (facts merged)
  log(msg: string): void;
}

export interface Adapter {
  /** Read identity + status; returns fields to store on the device row. */
  refresh(ctx: AdapterCtx): Promise<Record<string, unknown>>;
  /** Trigger pairing / authorization prompt. */
  pair(ctx: AdapterCtx): Promise<{ ok: boolean; detail: string }>;
  command(ctx: AdapterCtx, command: string, args: Record<string, any>): Promise<any>;
  /** Extra commands that are routine (reads, sliders, transport) and are not written to the audit log. */
  quiet?: ReadonlySet<string>;
}

export class AdapterError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export const KEY_NAMES = [
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'OK', 'BACK', 'HOME', 'MENU', 'PLAY_PAUSE', 'PLAY', 'PAUSE', 'STOP', 'NEXT', 'PREV',
  'REWIND', 'FF', 'VOL_UP', 'VOL_DOWN', 'MUTE', 'POWER', 'CH_UP', 'CH_DOWN', 'SETTINGS', 'SEARCH', 'INFO', 'INPUT', 'GUIDE',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export function requireKey(k: unknown): KeyName {
  if (typeof k !== 'string' || !(KEY_NAMES as readonly string[]).includes(k.toUpperCase())) throw new AdapterError('bad_args', `Unknown key ${String(k)}`);
  return k.toUpperCase() as KeyName;
}

/** Minimal XML helpers (Workers have no DOMParser). */
export function xmlTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`));
  return m ? m[1].trim() : null;
}
export function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
export function xmlAttrs(tagSrc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tagSrc.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) out[m[1]] = xmlUnescape(m[2]);
  return out;
}
