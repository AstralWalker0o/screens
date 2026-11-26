// Sonos types shared by the Worker adapter (src/worker/adapters/sonos.ts) and the dashboard.

export type SonosRepeat = 'off' | 'all' | 'one';

/** Where the current audio comes from (derived from the track / transport URI). */
export type SonosSource = 'music' | 'radio' | 'tv' | 'line_in' | 'airplay' | 'spotify_connect' | 'app' | 'none';

export interface SonosNowPlaying {
  state?: string; title?: string; artist?: string; album?: string;
  /** Album art: an absolute https URL, or a speaker-relative path ("/getaa?…") served through /api/devices/:id/sonos/art. */
  art?: string;
  /** Radio station / programme name when `title` is the stream's "now playing" text. */
  station?: string;
  volume?: number; muted?: boolean;
  source?: SonosSource; service?: string | null;
}

/** A bonded speaker that isn't a room of its own (Sub, surrounds, the second half of a stereo pair). */
export interface SonosBonded { uuid: string; role: string; ip: string | null }

/** A room (visible zone) in the household. */
export interface SonosZone { uuid: string; name: string; ip: string | null; coordinator: string; bonded?: SonosBonded[] }

export interface SonosGroupMember { uuid: string; name: string; ip: string | null; volume?: number | null; muted?: boolean | null }

export interface SonosGroupFacts {
  coordinator: string; is_coordinator: boolean; members: SonosGroupMember[];
  /** Group volume / mute (GroupRenderingControl), read on demand by `status`. */
  volume?: number | null; muted?: boolean | null;
}

export interface SonosEq {
  bass: number; treble: number; loudness: boolean;
  night_mode?: boolean | string; speech?: boolean | string;
}

/** Home-theatre levels (soundbars, Amp, or speakers with a bonded Sub). null = not supported. */
export interface SonosHtLevels {
  night_mode?: boolean | null; speech?: boolean | null;
  sub_enabled?: boolean | null; sub_gain?: number | null;
  surround_enabled?: boolean | null; surround_level?: number | null; music_surround_level?: number | null;
  height_level?: number | null; audio_delay?: number | null;
}

export interface SonosLastError { command: string; message: string; code?: string; at: number }

/** Device.facts for kind 'sonos'. Fields are filled by refresh (every 5 min) and the on-demand `status` command. */
export interface SonosFacts {
  uuid: string; room?: string; model_number?: string; display_version?: string; api_version?: string; led?: boolean | null;
  now_playing?: SonosNowPlaying;
  position?: { elapsed_s: number | null; duration_s: number | null; track?: number | null; at?: number };
  group?: SonosGroupFacts;
  zones?: SonosZone[];
  eq?: SonosEq;
  ht?: SonosHtLevels;
  has_line_in?: boolean; has_tv?: boolean;
  /** Set when this device is a satellite (Sub/surround/stereo partner) of another room. */
  bonded_to?: { uuid: string; name: string; role: string } | null;
  play_mode?: { shuffle: boolean; repeat: SonosRepeat } | null;
  crossfade?: boolean | null;
  sleep_timer?: { remaining_s: number; at: number } | null;
  button_lock?: boolean | null;
  transport?: { kind: string; can_seek: boolean; can_skip: boolean; can_shuffle: boolean } | null;
  /** The last command that failed on this device (any device kind records this). */
  last_error?: SonosLastError | null;
  status_at?: number;
}

export interface SonosQueueItem { index: number; title: string; artist?: string; album?: string; art?: string; duration_s?: number | null }
export interface SonosQueue { items: SonosQueueItem[]; total: number; start: number; current: number | null; active: boolean }

/** A playable item from favourites or Sonos playlists (send uri + meta back to play_favorite). */
export interface SonosBrowseItem { id?: string; title: string; uri: string; meta: string; art?: string; kind: 'radio' | 'playlist' | 'track'; description?: string }

export interface SonosInput { kind: 'line_in' | 'tv'; uuid: string; name: string; device_id?: string | null }

export interface SonosAlarm {
  id: string; time: string; duration: string | null; recurrence: string; days: string; enabled: boolean;
  room_uuid: string; room: string | null; program: string; volume: number; play_mode: string; include_grouped: boolean;
}

export interface SonosSettings {
  led: boolean | null; button_lock: boolean | null; eq: SonosEq | null; ht: SonosHtLevels | null;
  crossfade: boolean | null; sleep_timer_s: number | null; has_tv: boolean; has_sub: boolean;
}

/** One group (or single room) in the site-wide Sonos view (GET /api/sites/:id/sonos). */
export interface SonosSiteGroup {
  id: string; coordinator_uuid: string; name: string;
  /** An adopted device in this group to send commands to (null: control it through `anchor_device_id` with `uuid`). */
  device_id: string | null;
  state: string; title?: string; artist?: string; album?: string; art?: string; station?: string;
  source?: SonosSource; service?: string | null;
  volume: number | null; muted: boolean | null;
  members: { uuid: string; name: string; ip: string | null; device_id: string | null; volume: number | null; muted: boolean | null; bonded?: SonosBonded[] }[];
}

export interface SonosSiteOverview { anchor_device_id: string; groups: SonosSiteGroup[]; updated_at: number }
