import type { SiteHub } from './hub/SiteHub';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  SITE_HUB: DurableObjectNamespace<SiteHub>;
  ASSETS: Fetcher;

  // vars
  ACCESS_TEAM_DOMAIN: string;   // e.g. https://myteam.cloudflareaccess.com
  ACCESS_AUD: string;           // Access application AUD tag
  DOT_BASE_DOMAIN: string;      // e.g. dns.screens.supercluster.au
  PUBLIC_URL?: string;          // optional override of the public origin

  // secrets
  SIGNING_SECRET: string;       // HMAC for signed agent URLs
  SECRETS_KEY: string;          // base64 32-byte AES-GCM key for device secrets
  CF_API_TOKEN?: string;        // runtime token: DNS edit on the DoT zone (optional)
  CF_ZONE_ID?: string;          // zone id for DOT_BASE_DOMAIN
  ACME_DIRECTORY?: string;      // override (e.g. Let's Encrypt staging)
  DEV_AUTH?: string;            // "1" = skip Access verification (local dev only)
}
