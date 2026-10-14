# Host deployment notes — a1

Operator notes for the OpenNVR deployment on this host (a1, 192.168.1.4, public
hostname a1.sifu.art): the architecture, the non-obvious switches, and the
failure modes already hit once. **No secrets belong in this file.**

---

## 1. Topology

    browser --80/443--> host nginx --> 127.0.0.1:8443   (OpenNVR's own nginx, self-signed)
                             |
                             +--/webrtc, /hls, /playback--> (proxied through that nginx)

    browser --8189/udp+tcp--> router --> 192.168.1.4:8189   (MediaMTX WebRTC ICE, NOT proxied)

* The **host nginx is the public edge** on 80/443 and terminates the real
  certificate; the stack's own nginx sits behind it.
* WebRTC **media does not go through nginx** — it is UDP to MediaMTX's ICE port.
  The router must forward 8189 in **UDP *and* TCP** for off-LAN viewing. TCP is
  enough as a fallback (browsers do ICE-TCP); UDP is the better path.

## 2. Certificates (Let's Encrypt)

* Issued with certbot's nginx plugin, with --redirect, for a1.sifu.art.
* Certificate: /etc/letsencrypt/live/a1.sifu.art/ ; renewal via certbot.timer.
* Vhost: /etc/nginx/sites-available/opennvr (symlinked into sites-enabled);
  websocket upgrade map in /etc/nginx/conf.d/opennvr-upgrade.conf.
* Renewal needs **port 80 reachable from the internet** (HTTP-01) — if the
  router's forward changes, renewal fails about 60 days later.
* The upstream block disables verification deliberately (proxy_ssl_verify off):
  OpenNVR's internal edge is self-signed.

## 3. Compose settings that matter (.env)

| Key | Value | Why |
|---|---|---|
| CORE_TAG | nguyenivan | locally built image (section 6); the published :main lacks the grid/single-view work |
| DETECT_PIPELINE_IMAGE | ghcr.io/open-nvr/detect-pipeline:main | **must be pinned**: it defaults to the CORE_TAG value, so bumping CORE_TAG alone points it at a tag that does not exist and the pipeline breaks |
| NGINX_BIND_HOST | 0.0.0.0 | also controls the **ICE port** publish; 127.0.0.1 silently kills live view for every other machine |
| NGINX_HOST_HTTP_PORT / NGINX_HOST_HTTPS_PORT | 8080 / 8443 | frees 80/443 for the host nginx |
| TZ | Asia/Saigon | recording folders are named in the operator's local time |

## 4. WebRTC ICE hosts — the part that fails silently

MediaMTX runs on the Docker bridge, so it can only discover 127.0.0.1 and 172.x
addresses. A browser cannot route to either, so unless something tells it the
host's real addresses, **the SDP answer carries no usable candidate and live view
fails with no error anywhere**.

* The advertised list lives in the **database** (security_settings, key
  webrtc_ice_hosts), seeded from MEDIAMTX_WEBRTC_HOSTS, and is pushed to MediaMTX
  at every MediaMTX start by its runOnInit hook.
* The validator **only accepts IP addresses** — a hostname is rejected. That is
  why the public address must be stored (and refreshed) rather than a DDNS name.
* **Known race:** if MediaMTX and the core are recreated together, the hook calls
  the core API before it is listening; the apply fails silently and MediaMTX keeps
  only the seed (the LAN IP) — LAN works, WAN does not. After any ./start.sh up
  that recreates both, re-check what MediaMTX holds.

### 4.1 Watcher (installed)

* /usr/local/bin/opennvr-refresh-ice-hosts.sh — resolves the public + LAN IP and
  **always re-applies** to MediaMTX (not only when the address changes, so it
  repairs the race above). Logs to /var/log/opennvr-ice-hosts.log (bounded).
* opennvr-ice-hosts.service + opennvr-ice-hosts.timer — every 5 minutes and
  2 minutes after boot.

### 4.2 Inspecting what a browser would receive

    1) GET /api/v1/streams/webrtc/<camera_id>   -> whep_url + a short-lived JWT
    2) POST a real SDP offer to <whep_url>?jwt=<token>
       the a=candidate: lines in the answer list exactly what ICE will try

Expected, healthy:

    27.64.73.74  8189  udp host                  # WAN (needs UDP forward)
    27.64.73.74  8189  tcp host tcptype passive  # WAN (needs TCP forward)
    192.168.1.4  8189  udp/tcp host              # LAN

Loopback and 172.x candidates are always present and are never usable by another
machine — treat them as noise.

## 5. Views

| Route | What it is |
|---|---|
| /grid | chromeless 6-slot wall for kiosks; ?cameras=3,1,7 picks and orders slots (otherwise the first six cameras by id) |
| /1 | one camera full-screen; ?i=<index> keeps position, ?auto rotates, ?auto&delay=15 sets the interval (min 3 s) |

Both are wrapped in ProtectedBare: they **require a logged-in session**. A kiosk
therefore has to establish the session once in its own browser profile (the
returnTo fix brings you back to the requested page after login/MFA).

## 6. Build and deploy

**Persist a change (frontend or backend):**

    cd /home/ubuntu/opennvr
    docker build -f Dockerfile -t ghcr.io/open-nvr/core:nguyenivan .
    ./start.sh up      # recreates the core because the image ID changed

About 10 minutes; the frontend stage dominates. CORE_TAG is already nguyenivan,
so the rebuilt image is picked up with no compose edit. This is the only way
changes survive a container recreate.

**Fast iteration (frontend only, seconds):**

    cd /home/ubuntu/opennvr/app && npm run build \
      && docker cp dist/. opennvr_core:/app/app/dist/

Ephemeral by design: the next recreate reverts to the image's copy, docker cp
*adds* without deleting (stale hashed assets accumulate), and the PWA **service
worker caches aggressively** — hard-reload or use the DevTools option 'Update on
reload' before concluding a change did not apply.

**Verify a build before switching anything:** run the image and look for the chunk
it should contain, e.g.

    docker run --rm --entrypoint sh ghcr.io/open-nvr/core:nguyenivan \
      -c 'ls /app/app/dist/assets | grep -i single'

## 7. Cameras

* Three OEM cameras stream on the **bare root path** rtsp://<ip>:554/ with no
  authentication; two **Amcrest** units (Dahua OEM) use
  rtsp://<ip>:554/cam/realmonitor?channel=1&subtype=0 with **digest** auth.
* Amcrest RTSP digest is **connection-bound**: the authenticated request must go
  over the same TCP connection as its 401 challenge, or it answers 401 forever.
* Recording is disabled with the supported **pause** mechanism (enable pausing
  once via PUT /system/settings/recording-pause, then
  POST /cameras/{id}/recording with enabled=false). It stores
  CameraConfig.recording_enabled=false, which the startup re-provisioner honours.
* **Known bug:** substream paths (cam-<id>-sub) record even when the camera is
  paused — the provisioning payload omits record, so they inherit
  pathDefaults.record: yes. Fix per path with the MediaMTX API
  (PATCH /v3/config/paths/patch/<path> with record=false), via
  MediaMtxAdminService.patch_path_by_name. Re-provisioning on restart will
  re-introduce it.

## 8. Agent-maintained files outside this repo

Helper scripts for everything above live in /home/ubuntu/nvr-setup/ and are
deliberately **not** committed (ICE watcher, camera backup, probes, login helpers).

## 9. Quick troubleshooting

| Symptom | First thing to check |
|---|---|
| Live view dead from the WAN only | webrtcAdditionalHosts (section 4) — the startup-hook race; then the 8189 forward |
| Live view dead everywhere | NGINX_BIND_HOST — is 8189 published on 0.0.0.0? (docker port opennvr_mediamtx) |
| /grid or /1 loads but is blank | are you logged in? the route is ProtectedBare |
| A just-deployed frontend change invisible | service-worker cache — hard-reload |
| An external port check says closed | re-test: a single external check can return a transient failure |
| Certificate renewal fails | port 80 forward / DNS no longer pointing here |

## 10. Kiosk (secondary host)

The chromeless views are meant to be driven full-screen by a kiosk browser on a
small Linux box (cage/Wayland + Chrome, no desktop). Lessons from setting that up:

* **cage needs a seat manager.** Without seatd (or a proper logind session) it
  dies instantly with \"Could not get primary session\"/\"Could not open tty0\" and
  a restart policy turns that into a tight crash loop. Install and enable seatd;
  its socket is root:video, so the kiosk user needs the video group (Debian/Ubuntu
  ship no seat group).
* **Give the kiosk a runtime dir.** /run is tmpfs: either set RuntimeDirectory on
  the unit or enable lingering for the user, otherwise XDG_RUNTIME_DIR points at a
  directory that does not exist after a reboot.
* **Contain the browser.** Cap the unit (MemoryHigh/MemoryMax, OOMScoreAdjust,
  LimitCORE=0) so a crashing browser can never take the NVR down with it, and use
  Restart=on-failure with a backoff rather than Restart=always.
* **The views need a session.** /grid and /1 are ProtectedBare, so the kiosk
  browser must log in once in its own profile; the kiosk URL is then
  https://a1.sifu.art/grid (or /1?auto).
* Kiosk boxes are often pre-SSE4.2 CPUs: NumPy 2.x wheels require the x86-64-v2
  baseline, so an old machine cannot run the prebuilt images at all (see the CPU
  check in the setup runbook).
