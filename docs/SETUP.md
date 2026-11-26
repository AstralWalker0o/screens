# Setting up a site

This is the checklist for bringing a new location (a client's home, a rental
property, your own place) under Screens.

## 1. The gateway VM

You need a small Linux VM (or a mini PC) that stays on at the site.

| | Minimum |
|---|---|
| OS | Ubuntu 22.04+/Debian 12 (any Linux with Docker works) |
| CPU / RAM / disk | 1 vCPU, 512 MB RAM, 2 GB disk |
| Software | Docker Engine with the Compose plugin (`curl -fsSL https://get.docker.com \| sh`) |
| Network | **A leg on every VLAN that should be covered.** At minimum the IoT/media VLAN where the TVs, Shields and Sonos live. Add the main VLAN too if you want the mDNS reflector to let phones find the Sonos speakers. |

Giving the VM more than one VLAN:

- **Proxmox:** add a second network device to the VM with the other VLAN tag
  (e.g. `net0` untagged/main, `net1` tag 20 for IoT). Inside the VM it shows
  up as a second interface (`ens19`), and DHCP is fine.
- **One trunked NIC:** create VLAN sub-interfaces in the VM (netplan `vlans:`),
  e.g. `ens18.20`.

Give the VM a **DHCP reservation (fixed IP) on the IoT VLAN**, because the
TVs will use that address as their DNS server.

## 2. Install the gateway

1. In Screens: **Sites → (your site) → Gateway → Add gateway**.
2. Copy the one-line command and run it on the VM:

   ```bash
   curl -fsSL https://<your-screens-url>/install/enr_xxxxx | sudo bash
   ```

3. The gateway appears as **online** within a minute. The link is single-use
   and expires after 24 hours. Updates later are a button on the Gateway tab.

## 3. Discover and adopt devices

**Discover** tab → **Scan**. Screens finds Samsung and LG TVs, Android TV boxes
and Sonos speakers on the gateway's subnets.

| Device | Before adopting | When you adopt |
|---|---|---|
| **NVIDIA Shield / Android TV** | Settings → Device Preferences → About → click *Build* 7 times. Then Developer options → enable **Network debugging** (on newer Google TV, **Wireless debugging**). | The TV shows **"Allow network debugging?"**. Tick *Always allow from this computer* and press **Allow** with the remote. |
| **Samsung TV** | Settings → General → External Device Manager → Device Connection Manager → *Access Notification* on. Also enable **Power On with Mobile** so Screens can switch it on. | The TV shows **"Screens wants to connect" → Allow**. |
| **LG TV** (beta) | Settings → General → Devices → *Mobile TV On* → **Turn on via Wi-Fi**. | The TV shows a pairing prompt. Choose **Accept**. |
| **Sonos** | Nothing. | Nothing. Sonos needs no pairing on the local network. |

## 4. Point the TVs at the Screens DNS filter

This is what lets Screens see and stop the spying. The router is left alone;
each device is changed instead.

- **Android TV / Shield:** on the device's **Privacy** tab, switch on
  **Private DNS**. It uses encrypted DNS-over-TLS to the gateway, at
  `<site>.dns.screens.supercluster.au`. Enable *Private DNS* in the site's
  Settings tab first, which issues a certificate for the site. Screens checks
  the device still has internet afterwards and switches back automatically if
  not.
- **Samsung:** Settings → General → Network → Network Status → IP Settings →
  DNS Setting → *Enter manually* → the gateway's IoT-VLAN IP.
- **LG:** Settings → General → Network → (Wired/Wi-Fi) → Edit → untick *Set
  automatically* → DNS → the gateway's IoT-VLAN IP.

New devices start in **Monitor** mode. For 3 days (configurable) Screens only
records what they talk to and what it *would* block. Then it switches them to
**Enforce** with the **Balanced** policy, and an alert tells you it happened.

If a device is online but no DNS lookups arrive, Screens raises a **"not using
the Screens DNS filter"** alert. That usually means the DNS setting wasn't
saved, or the device has hard-coded DNS (e.g. 8.8.8.8).

## 5. Tick off the privacy checklist

Some spying settings can only be changed on the TV itself (Samsung "Viewing
Information Services", LG "Live Plus", ad tracking, voice). Each device's
**Privacy** tab has a checklist with the exact menu path. Tick each item once
it's done, and the privacy score goes up.

## 6. mDNS reflector (Sonos across VLANs)

**Site → mDNS reflector**:

1. Pick the gateway interfaces: the IoT VLAN (speakers) and the main VLAN
   (phones).
2. Add rules:
   - *IoT → Main*: allow `_sonos._tcp`, `_spotify-connect._tcp`,
     `_airplay._tcp`, `_raop._tcp`, `_googlecast._tcp`.
   - *Main → IoT*: allow `*` (queries).
3. Enable **SSDP** for older Sonos controllers.

The reflector only carries the *announcements*. Your firewall still has to
allow phones on the main VLAN to reach the speakers, for example TCP 1400,
1443, 3400, 3401, 3500, 4444 and UDP 1900, 1901, 5353 to the Sonos IPs. Do
that on your Palo Alto or UniFi.

## 7. Rentals: guest reset

For rental sites, the **Guest** tab has **Guest reset**, which signs every
Android box out of the streaming apps by clearing their data. You choose which
apps are cleared. To do it automatically, add an automation, e.g.
"Guest reset at 11:00 every day" (or after each checkout).
