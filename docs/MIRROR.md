# Live screen mirroring (Android)

Live mirroring uses [scrcpy](https://github.com/Genymobile/scrcpy)'s on-device server, **v5.0.1** (Apache-2.0).
It captures the screen as H.264 and accepts touch, key and scroll input. Its pieces sit across Screens like this:

```
Browser (WebCodecs → <canvas>)  ⇄  Worker /api/devices/:id/mirror  ⇄  SiteHub (session, packet framing)
        ⇄  gateway adb.stream (raw bytes)  ⇄  adb  ⇄  localabstract:scrcpy_<scid> on the TV box
```

- The scrcpy server jar is distributed from R2 (`vendor/scrcpy-server-v5.0.1`, sha256
  `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`, the value pinned by upstream's
  `install_release.sh`). It is pushed to `/data/local/tmp/screens-scrcpy-5.0.1.jar` when missing.
- There is one session per device. Several viewers can watch the same session. When a viewer joins, the hub sends
  `RESET_VIDEO` so the new viewer gets a fresh keyframe.
- The session ends when the last viewer leaves. The hub then closes the sockets, and scrcpy's `cleanup=true`
  restores the device.

## Browser ⇄ hub WebSocket

`wss://<host>/api/devices/:id/mirror?max_size=1280&max_fps=30&bitrate=4000000`
(same-origin, so the Cloudflare Access cookie applies). All three query params are optional:
`max_size` is 480–1920, `max_fps` is 5–60, `bitrate` is 0.5–16 Mbps.

### Server → browser

**Text frames (JSON):**

```json
{ "type": "status", "state": "starting" | "streaming" | "ended" | "error", "message": "…" }
{ "type": "meta", "device_name": "SHIELD Android TV", "codec": "h264", "width": 1280, "height": 720 }
```

- `meta` is sent once the stream header is known. Viewers that join later get it immediately.
- `width`/`height` here are the current session size. Session packets (below) can change them later, for
  example on rotation or resolution change.

**Binary frames (one scrcpy unit per frame, already aligned):**

- **Media packet:** 12-byte header + payload.
  - `u64 BE pts_flags`:
    - bit 62 = config packet (SPS/PPS, no PTS);
    - bit 61 = keyframe;
    - the PTS in microseconds is `pts_flags & ((1n<<61n)-1n)`.
  - `u32 BE length`, followed by `length` bytes of H.264 Annex-B data.
- **Session packet:** exactly 12 bytes with no payload.
  - The first byte's MSB is set (`bytes[0] & 0x80`).
  - `u32 BE flags`, where bit 0 = client resized.
  - `u32 BE width`, `u32 BE height`.

**Decoding rules (same as scrcpy's client):**

- Keep the latest config packet and prepend it to the next media packet before decoding.
- Configure `VideoDecoder` from the SPS:
  - `codec: avc1.PPCCLL`, where PP, CC and LL are the SPS profile_idc, constraint byte and level_idc, as hex;
  - pass no `description`, because the stream is Annex-B;
  - set `optimizeForLatency: true`.
- Start decoding at the first keyframe.
- Reconfigure on a new session packet or a changed SPS.

### Browser → server

**Binary frames** are raw scrcpy control messages, big-endian. The hub only forwards these types:

| type | name | layout (after the 1-byte type) |
|---|---|---|
| 0 | INJECT_KEYCODE | `u8 action` (0 down, 1 up), `i32 keycode`, `i32 repeat`, `i32 metaState`. 14 bytes in total. |
| 1 | INJECT_TEXT | `u32 len` + UTF-8 (≤ 300 bytes) |
| 2 | INJECT_TOUCH_EVENT | `u8 action` (0 down, 1 up, 2 move), `i64 pointerId` (−1 = mouse, −2 = generic finger), `i32 x`, `i32 y`, `u16 screenW`, `u16 screenH`, `u16 pressure` (0xffff = 1.0), `i32 actionButton`, `i32 buttons`. 32 bytes in total. `x`/`y` are in video pixels and `screenW`/`H` must equal the current session width/height. |
| 3 | INJECT_SCROLL_EVENT | `i32 x`, `i32 y`, `u16 screenW`, `u16 screenH`, `i16 hscroll`, `i16 vscroll` (fixed point, value/16 × 32767, range ±16), `i32 buttons`. 21 bytes in total. |
| 4 | BACK_OR_SCREEN_ON | `u8 action` (0 down, 1 up) |
| 10 | SET_DISPLAY_POWER | `u8 on` |
| 17 | RESET_VIDEO | (no payload): asks for a new keyframe |

**Text frames:** `{"type":"ping"}` keeps the connection alive. The hub answers with `{"type":"pong"}`.

## Hub ⇄ gateway

- **`adb.stream`** `{stream, serial, service}`, where service must match `^localabstract:scrcpy_[0-9a-f]{8}$`.
  - The gateway opens the service through its local adb server (smart-socket `host:transport:<serial>`,
    then `<service>`) and relays it exactly like `tcp.open`.
- **Binary link frames** (when the gateway advertises `binary_streams` in `hello.caps`). Stream data in
  both directions is sent as WebSocket **binary** messages:
  - byte 0: `0x01`;
  - byte 1: stream-id length `n`;
  - bytes 2…2+n: stream id (ASCII);
  - the rest: payload.

  Text `stream` frames with `close` are unchanged. A gateway without the cap keeps using base64 text frames.

## Server start command (run by the hub over `adb.shell`)

```sh
CLASSPATH=/data/local/tmp/screens-scrcpy-5.0.1.jar nohup app_process / com.genymobile.scrcpy.Server 5.0.1 \
  scid=<8 hex> log_level=info audio=false control=true tunnel_forward=true video_codec=h264 \
  max_size=<n> max_fps=<n> video_bit_rate=<bps> cleanup=true power_off_on_close=false clipboard_autosync=false \
  send_device_meta=true send_frame_meta=true send_dummy_byte=true send_stream_meta=true >/dev/null 2>&1 &
```

The hub connects the video socket first and the control socket second. On the video socket it reads:

1. the dummy byte (`0x00`);
2. a 64-byte NUL-padded device name;
3. a `u32` codec id (`0x68323634` = "h264");
4. the first session packet;
5. packets, until the socket closes.
