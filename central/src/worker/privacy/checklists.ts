import type { ChecklistItem, DeviceKind } from '../../shared/types';

type Item = Omit<ChecklistItem, 'done'>;

/**
 * Manual privacy settings that no local API can change. The owner ticks them off.
 * Items with `auto: true` are evaluated by Screens itself.
 */
export const CHECKLISTS: Record<DeviceKind, Item[]> = {
  samsung: [
    { key: 'dns_routed', label: 'TV uses the Screens DNS filter', auto: true, how: 'Settings → All Settings → General & Privacy → Network → Network Status → IP Settings → DNS setting → Enter manually → the gateway IP shown on the site\'s Gateway tab.' },
    { key: 'viewing_info', label: 'Viewing Information Services (ACR) turned off', how: 'Settings → All Settings → General & Privacy → Terms & Privacy → Privacy Choices → Viewing Information Services → turn off. (Older models: Settings → Support → Terms & Policy.)' },
    { key: 'interest_ads', label: 'Interest-Based Advertisement turned off', how: 'Settings → All Settings → General & Privacy → Terms & Privacy → Privacy Choices → Interest-Based Advertisement → turn off, then choose "Reset PSID".' },
    { key: 'voice', label: 'Voice recognition / Bixby wake-up off', how: 'Settings → General & Privacy → Voice → Voice Wake-up → off, and Terms & Privacy → Voice Recognition Services → disagree.' },
    { key: 'autorun', label: 'Autorun Smart Hub & last app off', how: 'Settings → General & Privacy → Start Screen Option (or Smart Features) → Autorun Smart Hub → off; Autorun Last App → off.' },
    { key: 'account', label: 'Signed out of Samsung account (if not needed)', how: 'Settings → General & Privacy → System Manager → Samsung Account → Sign out.' },
    { key: 'power_on_mobile', label: '"Power On with Mobile" enabled (lets Screens turn the TV on)', how: 'Settings → General & Privacy → External Device Manager → Device Connection Manager → Access Notification / Power On with Mobile → on.' },
  ],
  lg: [
    { key: 'dns_routed', label: 'TV uses the Screens DNS filter', auto: true, how: 'Settings → All Settings → General → Network → Wired/Wi-Fi → Edit → uncheck "Set Automatically" → DNS Server → the gateway IP.' },
    { key: 'live_plus', label: 'Live Plus (ACR) turned off', how: 'Settings → All Settings → General → System → Additional Settings → Live Plus → off.' },
    { key: 'ad_tracking', label: 'Limit Ad Tracking on', how: 'Settings → All Settings → General → System → Additional Settings → Advertisement → Limit AD Tracking → on.' },
    { key: 'agreements', label: 'Optional user agreements withdrawn', how: 'Settings → All Settings → General → System → User Agreements → untick Viewing Information, Voice Information and Interest-Based Recommendation.' },
    { key: 'home_promo', label: 'Home promotions & recommendations off', how: 'Settings → All Settings → General → System → Additional Settings → Home Settings → Home Promotion → off; Content Recommendation → off.' },
    { key: 'wol', label: '"Turn on via Wi-Fi" enabled (lets Screens turn the TV on)', how: 'Settings → All Settings → General → Devices → External Devices → Mobile TV On → Turn on via Wi-Fi → on.' },
  ],
  android: [
    { key: 'dns_routed', label: 'Device uses the Screens DNS filter', auto: true, how: 'Use the Private DNS switch on this page (DNS-over-TLS to the gateway), or set the gateway IP as DNS in Network settings.' },
    { key: 'usage_diag', label: 'Usage & diagnostics sharing off', how: 'Settings → Device Preferences → Usage & Diagnostics → off.' },
    { key: 'ads', label: 'Ads personalisation off / advertising ID deleted', how: 'Settings → Google (or Privacy) → Ads → Delete advertising ID (or "Opt out of Ads Personalization").' },
    { key: 'assistant', label: 'Google Assistant disabled if not used', how: 'Disable "Google app (Assistant)" on the Apps tab, or Settings → Google Assistant → off.' },
    { key: 'unknown_sources', label: 'Unknown sources only allowed for apps that need it', how: 'Settings → Device Preferences → Security & restrictions → Unknown sources → turn off for anything you don\'t recognise.' },
    { key: 'debug_keys', label: 'Only the Screens gateway is authorised for debugging', how: 'Settings → Device Preferences → Developer options → Revoke USB debugging authorisations, then re-pair from Screens.' },
  ],
  sonos: [
    { key: 'usage_data', label: '"Additional usage data" sharing off', how: 'Sonos app → Settings → Privacy & Security (or Account → Privacy) → Additional Usage Data → off.' },
    { key: 'voice', label: 'Microphone off when no voice assistant is used', how: 'Press the microphone button on the speaker (light goes off), or Sonos app → room → Voice Services → remove assistants.' },
    { key: 'location', label: 'Location sharing off in the Sonos app', how: 'Phone settings → Sonos → Location → Never (only needed during setup).' },
  ],
  other: [],
};
