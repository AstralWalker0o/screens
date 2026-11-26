// Look-alike TV banners for the dashboard preview. Boxes show each app's real banner; the browser can't
// read those, so well-known apps get a coloured wordmark and everything else gets the launcher's own
// fallback (app initials on an accent-tinted card, contract §3).

export interface BrandStyle {
  /** Card background (CSS). */
  bg: string;
  /** Wordmark text and colour. */
  word: string;
  fg: string;
  /** Wordmark font tweaks. */
  weight?: number;
  tracking?: string;
  italic?: boolean;
  lower?: boolean;
  /** Small mark drawn before the wordmark. */
  mark?: 'play' | 'chevron' | 'swoosh' | 'dot' | 'plus';
  markColor?: string;
}

export const BRANDS: Record<string, BrandStyle> = {
  'com.netflix.ninja': { bg: '#000000', word: 'NETFLIX', fg: '#e50914', weight: 900, tracking: '0.02em' },
  'com.google.android.youtube.tv': { bg: 'linear-gradient(160deg, #1c1c1c 0%, #0b0b0b 100%)', word: 'YouTube', fg: '#ffffff', weight: 700, tracking: '-0.03em', mark: 'play', markColor: '#ff0033' },
  'com.google.android.youtube.tvmusic': { bg: '#0b0b0b', word: 'Music', fg: '#ffffff', weight: 700, mark: 'play', markColor: '#ff0033' },
  'com.plexapp.android': { bg: 'linear-gradient(150deg, #2b2f33 0%, #1b1e21 100%)', word: 'plex', fg: '#ffffff', weight: 800, lower: true, mark: 'chevron', markColor: '#ebaf00' },
  'com.amazon.amazonvideo.livingroom': { bg: 'linear-gradient(150deg, #0f2a43 0%, #0b1622 100%)', word: 'prime video', fg: '#ffffff', weight: 700, lower: true, mark: 'swoosh', markColor: '#1a98ff' },
  'au.com.kayo.ott': { bg: 'linear-gradient(150deg, #101010 0%, #000000 100%)', word: 'kayo', fg: '#00e676', weight: 900, lower: true, italic: true },
  'au.com.kayosports.tv': { bg: 'linear-gradient(150deg, #101010 0%, #000000 100%)', word: 'kayo', fg: '#00e676', weight: 900, lower: true, italic: true },
  'org.jellyfin.androidtv': { bg: 'linear-gradient(135deg, #aa5cc3 0%, #00a4dc 100%)', word: 'Jellyfin', fg: '#ffffff', weight: 700, tracking: '-0.01em', mark: 'dot', markColor: '#ffffff' },
  'au.com.stan.and': { bg: 'linear-gradient(150deg, #0f7ff3 0%, #0657c2 100%)', word: 'Stan.', fg: '#ffffff', weight: 800, tracking: '-0.02em' },
  'com.disney.disneyplus': { bg: 'radial-gradient(120% 140% at 50% 120%, #2f6ad9 0%, #0b1b51 60%, #050b26 100%)', word: 'Disney', fg: '#ffffff', weight: 600, italic: true, mark: 'plus', markColor: '#7ed1ff' },
  'com.spotify.tv.android': { bg: '#121212', word: 'Spotify', fg: '#1ed760', weight: 800, tracking: '-0.02em' },
  'au.net.abc.iview': { bg: '#000000', word: 'ABC iview', fg: '#ffffff', weight: 700 },
  'com.teamsmart.videomanager.tv': { bg: 'linear-gradient(150deg, #e53935 0%, #8e1512 100%)', word: 'SmartTube', fg: '#ffffff', weight: 700, mark: 'play', markColor: '#ffffff' },
  'com.apple.atve.androidtv.appletv': { bg: '#000000', word: 'tv', fg: '#ffffff', weight: 600, lower: true },
  'com.wbd.stream': { bg: 'linear-gradient(150deg, #0026ff 0%, #001a8c 100%)', word: 'max', fg: '#ffffff', weight: 800, lower: true },
  'au.com.streamotion.ares': { bg: 'linear-gradient(150deg, #5a2ee6 0%, #2a0f86 100%)', word: 'BINGE', fg: '#ffffff', weight: 900, tracking: '0.06em' },
  'tv.pluto.android': { bg: '#0a0a0a', word: 'pluto tv', fg: '#fff200', weight: 800, lower: true },
  'com.mxtech.videoplayer.ad': { bg: 'linear-gradient(150deg, #1e88e5 0%, #0d47a1 100%)', word: 'MX Player', fg: '#ffffff', weight: 700, mark: 'play', markColor: '#ffffff' },
  'com.android.vending': { bg: 'linear-gradient(150deg, #ffffff 0%, #e8eaed 100%)', word: 'Google Play', fg: '#3c4043', weight: 600, mark: 'play', markColor: '#01875f' },
  'com.spocky.projengmenu': { bg: 'linear-gradient(150deg, #3949ab 0%, #1a237e 100%)', word: 'Projectivy', fg: '#ffffff', weight: 700 },
  'com.zoom.videomeetings.tv': { bg: '#0b5cff', word: 'zoom', fg: '#ffffff', weight: 800, lower: true },
  'au.coastal.welcome': { bg: 'linear-gradient(150deg, #00897b 0%, #004d40 100%)', word: 'Welcome', fg: '#ffffff', weight: 700 },
};

export function hue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function initials(label: string): string {
  const words = label.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  return (words[0][0] + words[1][0]).toUpperCase();
}
