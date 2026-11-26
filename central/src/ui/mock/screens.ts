// Fake Android TV screenshots for mock mode: a Google-TV-style home screen whose
// focus moves with remote keys/taps, and a simple "app is playing" screen.

export interface ScreenState { focus: number; row: 0 | 1; app: string | null; tab: number }

export const TILES = [
  { label: 'Netflix', pkg: 'com.netflix.ninja', bg: '#141414', fg: '#e50914' },
  { label: 'YouTube', pkg: 'com.google.android.youtube.tv', bg: '#ffffff', fg: '#ff0033' },
  { label: 'Plex', pkg: 'com.plexapp.android', bg: '#1f2326', fg: '#e5a00d' },
  { label: 'Stan', pkg: 'au.com.stan.and', bg: '#0b1d3a', fg: '#4aa3ff' },
  { label: 'Disney+', pkg: 'com.disney.disneyplus', bg: '#0e2a6b', fg: '#ffffff' },
  { label: 'Prime Video', pkg: 'com.amazon.amazonvideo.livingroom', bg: '#00a8e1', fg: '#ffffff' },
  { label: 'Spotify', pkg: 'com.spotify.tv.android', bg: '#121212', fg: '#1ed760' },
];
const TABS = ['For you', 'Movies', 'Shows', 'Apps', 'Library'];

export const tileRect = (i: number) => ({ x: 64 + i * 180, y: 452, w: 164, h: 92 });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function renderScreen(st: ScreenState, now = new Date()): string {
  const clock = now.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: 'Australia/Sydney' });
  let body: string;
  if (st.app) {
    const t = TILES.find((x) => x.label === st.app) ?? { label: st.app, bg: '#111', fg: '#fff' };
    body = `
      <rect width="1280" height="720" fill="${t.bg}"/>
      <rect width="1280" height="720" fill="url(#vig)"/>
      <text x="64" y="96" font-size="34" font-weight="700" fill="${t.fg}">${esc(t.label)}</text>
      <text x="64" y="470" font-size="46" font-weight="700" fill="#fff">The Night Agent</text>
      <text x="64" y="512" font-size="22" fill="#cfd3da">Season 2 · Episode 4 · “Kill Box”</text>
      <rect x="64" y="600" width="1152" height="6" rx="3" fill="#ffffff" fill-opacity="0.25"/>
      <rect x="64" y="600" width="430" height="6" rx="3" fill="${t.fg === '#ffffff' ? '#4aa3ff' : t.fg}"/>
      <circle cx="494" cy="603" r="10" fill="#fff"/>
      <text x="64" y="640" font-size="18" fill="#cfd3da">18:42</text>
      <text x="1216" y="640" font-size="18" fill="#cfd3da" text-anchor="end">49:10</text>`;
  } else {
    const tabs = TABS.map((t, i) => {
      const x = 64 + i * 128;
      const on = i === st.tab;
      return `<g><rect x="${x - 14}" y="30" width="${t.length * 11 + 28}" height="40" rx="20" fill="${on ? '#e8eaed' : 'none'}"/>
        <text x="${x}" y="57" font-size="19" font-weight="${on ? 700 : 500}" fill="${on ? '#1b1c1f' : '#c4c7cc'}">${t}</text></g>`;
    }).join('');
    const tiles = TILES.map((t, i) => {
      const r = tileRect(i);
      const focused = st.row === 0 && st.focus === i;
      const s = focused ? 1.08 : 1;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      return `<g transform="translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})">
        ${focused ? `<rect x="${r.x - 5}" y="${r.y - 5}" width="${r.w + 10}" height="${r.h + 10}" rx="14" fill="none" stroke="#fff" stroke-width="4"/>` : ''}
        <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" fill="${t.bg}" stroke="#ffffff" stroke-opacity="0.08"/>
        <text x="${cx}" y="${cy + 8}" font-size="${t.label.length > 8 ? 20 : 24}" font-weight="800" fill="${t.fg}" text-anchor="middle">${esc(t.label)}</text>
      </g>`;
    }).join('');
    const cont = [0, 1, 2, 3, 4].map((i) => {
      const x = 64 + i * 236;
      const focused = st.row === 1 && st.focus === i;
      return `<g>${focused ? `<rect x="${x - 5}" y="619" width="230" height="140" rx="14" fill="none" stroke="#fff" stroke-width="4"/>` : ''}
        <rect x="${x}" y="624" width="220" height="130" rx="10" fill="hsl(${200 + i * 37} 35% 28%)"/>
        <rect x="${x + 12}" y="730" width="${60 + i * 25}" height="4" rx="2" fill="#e8eaed"/></g>`;
    }).join('');
    const focusedTile = TILES[st.row === 0 ? st.focus : 0];
    body = `
      <rect width="1280" height="720" fill="url(#bg)"/>
      ${tabs}
      <text x="1150" y="58" font-size="22" font-weight="500" fill="#e8eaed" text-anchor="end">${clock}</text>
      <circle cx="1196" cy="50" r="18" fill="#5b8def"/><text x="1196" y="57" font-size="18" font-weight="700" fill="#fff" text-anchor="middle">S</text>
      <rect x="64" y="96" width="1152" height="300" rx="18" fill="url(#hero)"/>
      <text x="104" y="220" font-size="40" font-weight="800" fill="#fff">The Night Agent</text>
      <text x="104" y="260" font-size="20" fill="#dfe3ea">New season · ${esc(st.row === 0 ? focusedTile.label : 'Netflix')}</text>
      <rect x="104" y="296" width="150" height="46" rx="23" fill="#fff"/><text x="179" y="326" font-size="19" font-weight="700" fill="#111" text-anchor="middle">Watch now</text>
      <text x="64" y="432" font-size="21" font-weight="600" fill="#e8eaed">Your apps</text>
      ${tiles}
      <text x="64" y="604" font-size="21" font-weight="600" fill="#e8eaed">Continue watching</text>
      ${cont}`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" font-family="Roboto, 'Helvetica Neue', Arial, sans-serif">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2230"/><stop offset="1" stop-color="#0d0f14"/></linearGradient>
      <linearGradient id="hero" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b2a4f"/><stop offset="0.55" stop-color="#1e3a5f"/><stop offset="1" stop-color="#0f2233"/></linearGradient>
      <radialGradient id="vig" cx="0.5" cy="0.4" r="0.8"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/></radialGradient>
    </defs>${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function applyKey(st: ScreenState, key: string): ScreenState {
  const n = { ...st };
  if (st.app) {
    if (key === 'BACK' || key === 'HOME') n.app = null;
    return n;
  }
  const max = st.row === 0 ? TILES.length - 1 : 4;
  if (key === 'RIGHT') n.focus = Math.min(max, st.focus + 1);
  if (key === 'LEFT') n.focus = Math.max(0, st.focus - 1);
  if (key === 'DOWN') {
    n.row = 1;
    n.focus = Math.min(4, st.focus);
  }
  if (key === 'UP') {
    if (st.row === 1) n.row = 0;
    else n.tab = Math.min(TABS.length - 1, st.tab);
  }
  if (key === 'OK') n.app = st.row === 0 ? TILES[st.focus].label : 'Netflix';
  if (key === 'HOME') {
    n.app = null;
    n.row = 0;
    n.focus = 0;
  }
  return n;
}

export function applyTap(st: ScreenState, x: number, y: number): ScreenState {
  if (st.app) return st;
  const px = x * 1280;
  const py = y * 720;
  for (let i = 0; i < TILES.length; i++) {
    const r = tileRect(i);
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return { ...st, row: 0, focus: i, app: TILES[i].label };
  }
  if (py > 20 && py < 80) {
    const tab = Math.floor((px - 50) / 128);
    if (tab >= 0 && tab < TABS.length) return { ...st, tab };
  }
  return st;
}
