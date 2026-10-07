# OpenNVR CCTV Platform — Development & System Administration Documentation

**Audience:** an engineer joining this system with no prior context. Everything below is written so you can reproduce it end to end.
**Revision:** 2026-10-07 · host `a1` · prepared from live system evidence, not from memory.

> Conventions:
> - `sudo` is required for anything touching Docker or systemd.
> - `sg docker -c '…'` runs a command with the docker group (works without re-login).
> - "**Verify:**" blocks show the command *and* the expected result. If you don't see it, stop and investigate — silent success is the dominant failure mode in this stack.
> - Secrets are referred to by **path**, never value. Do not paste secret values into tickets or chat.

---

## 1. System overview

### 1.1 Host and network

| Item | Value |
|---|---|
| Hostname | `a1` |
| OS | Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic, x86_64 |
| CPU / RAM / disk | 4 vCPU / 31 GB / 109 GB root (`/dev/sda2`) |
| LAN interface | `enp2s0f0` — **192.168.1.4/24**, gateway 192.168.1.1 |
| Overlay | `tailscale0` — 100.114.113.104/32 (admin access) |
| Public address | **dynamic**. Observed 27.74.71.227 → 27.74.119.56 (changed 2026-10-06) |
| Domain | `a1.sifu.art` → A record, **TTL 300 s**, refreshed ~every 5 min by the EdgeRouter |
| Apex `sifu.art` | unrelated, served by CloudFront |
| Camera LAN | three ONVIF cameras at 192.168.1.81 / .82 / .85 |

### 1.2 What runs here

Two independent Docker Compose stacks, **both using the same container names** (`opennvr_core`, `opennvr_db`, …). Only one can run at a time.

| Stack | Directory | Compose project | Purpose |
|---|---|---|---|
| **production** | `/home/ubuntu/opennvr` | `opennvr` | the live NVR: cameras, recording, detection |
| **test** | `/home/ubuntu/working` | `working` | fork checkout used to develop/test the `/grid` feature |
| (test harness) | `/home/ubuntu/working` | `opennvr-e2e` | isolated stack for automated e2e tests, renamed `opennvr_e2e_*` |

> **This is the most confusing thing about the box.** `docker ps` shows `opennvr_core` regardless of which stack is up. **Always ask the project label before acting:**
> ```bash
> docker ps -a --format '{{.Names}} | {{.Label "com.docker.compose.project"}} | {{.Image}} | {{.Status}}'
> ```

### 1.3 Container roles (stock install)

| Container | Role | Published ports |
|---|---|---|
| `opennvr_nginx` | TLS edge; serves the SPA, proxies `/api`, `/webrtc/`, `/hls/`, `/playback/` | 80, 443 |
| `opennvr_core` | FastAPI backend + auth + provisioning + retention | 127.0.0.1:8000 |
| `opennvr_db` | PostgreSQL 15 | internal |
| `opennvr_mediamtx` | RTSP ingest, WebRTC/HLS egress, recording | 8189 tcp+udp (ICE) |
| `opennvr_nats` / `opennvr_nats_apps` | event bus | internal |
| `opennvr_detect_pipeline` | Tier-0 motion→detect→track (YOLOv8n ONNX, CPU) | internal |
| `opennvr_yolov8_adapter` | model adapter | internal |
| `opennvr_footage_search`, `opennvr_occupancy_counting`, `opennvr_egress_proxy` | default apps (profile `default-apps`) | internal |
| `*_init` (3×) | one-shot: generate certs, fetch weights, write app config | — (`Exited (0)` is correct) |

### 1.4 Paths you will need

| Path | Contents |
|---|---|
| `/home/ubuntu/opennvr` | production checkout; `.env` holds the stack secrets |
| `/home/ubuntu/opennvr/.env` | generated secrets + settings (**never commit/copy**) |
| `/home/ubuntu/opennvr/recordings/` | video: `cam-<id>/YYYY-MM-DD/HH/MM-SS-ffffff.mp4` |
| `/home/ubuntu/opennvr/nginx-certs/` | TLS pair served by the edge (+ `selfsigned-backup/`) |
| `/home/ubuntu/opennvr/ADMIN_CREDENTIALS.txt` | admin password + TOTP secret, mode 600 |
| `/home/ubuntu/working` | fork checkout (the `/grid` work) — its own `.env` |
| `/home/ubuntu/working/tests/e2e/.artifacts/runs/report.md` | e2e report; `ISSUE.md` per failure |
| `/home/ubuntu/opennvr-setup/` | 58 helper scripts written during this work (see §6.3) |
| `/etc/letsencrypt/` | ACME account, cert, renewal config, **deploy hooks** |
| `/home/ubuntu/.openclaw/workspace` | runbooks: this file, `setup-cctv-prompt.txt`, `live-view-plan.md`, `memory/` |

---

## 2. Architecture

### 2.1 Request and media paths

```
browser --https(443)--> opennvr_nginx --http--> opennvr_core (127.0.0.1:8000)
                                |
                                +-- /webrtc/ , /hls/ , /playback/ --> opennvr_mediamtx (TLS, self-signed, internal)

camera --rtsp(554)--> opennvr_mediamtx --+--> recording (fMP4 segments on disk)
                                         +--> WebRTC (WHEP) to browser  [needs a REACHABLE ICE candidate]
                                         +--> detect-pipeline (Tier-0 inference)
```

The critical consequence: **signalling rides 443 and is easy; media rides UDP 8189 and is where things break.** A camera can be "Online / Recording" with a real snapshot while Live View spins forever — that combination always means "the browser was given an ICE candidate it cannot reach".

### 2.2 Why there are two stacks

The fork (`/home/ubuntu/working`) contains four commits that do not exist upstream, so testing them requires **that** checkout's image. Because `docker-compose.yml` hardcodes absolute container names, the two stacks cannot coexist — hence the three options in §6.4.

---

## 3. System administration process (chronological, reproducible)

### 3.1 Host provisioning

```bash
# Baseline recon — do this first, always
uname -a; . /etc/os-release && echo "$PRETTY_NAME"
nproc; free -h | head -2; df -h /
ip -4 -o addr show | awk '{print $2, $4}'
sysctl -n net.ipv4.ip_unprivileged_port_start      # NOTE THE VALUE
sudo -n true && echo "passwordless sudo OK"
```

**Note `ip_unprivileged_port_start`.** Here it is **1024**, and that single value causes the launcher failure in §5, Challenge 1.

### 3.2 Docker Engine + Compose

Use Docker's own apt repository, not `docker.io`:

```bash
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

**Verify:** `docker --version` and `docker compose version` (reference: 29.8.1 / v5.5.1).

Gotchas learned here:
- A freshly added `docker` group does **not** apply to your current shell — use `sg docker -c '…'` or `sudo`.
- `apt-get` may be locked by `unattended-upgrades`. Wait; never force.
- **Prefer apt over snap for CLI tools here.** A `snap install certbot --classic` stalled downloading the `core24` base snap at 4–9 MB/min and had to be aborted.

### 3.3 Install OpenNVR (production)

```bash
git clone --depth 1 --single-branch https://github.com/open-nvr/open-nvr.git /home/ubuntu/opennvr
cd /home/ubuntu/opennvr
cp .env.example .env
./scripts/generate-secrets.sh --write     # writes 5 secrets into .env
```

What it writes, and why each matters:
- `SECRET_KEY` — signs JWTs.
- `CREDENTIAL_ENCRYPTION_KEY` — **Fernet key; encrypts camera credentials and the MFA secret at rest. Never change it after first run.**
- `INTERNAL_API_KEY` — internal/NATS auth (compose **fails to start** without it).
- `MEDIAMTX_SECRET` — authenticates core↔MediaMTX admin/hook calls.
- `POSTGRES_PASSWORD`.

The core **refuses to boot with placeholder secrets**. There are no shipped default credentials, ever.

### 3.4 Start the stack — and the `sudo` requirement

```bash
cd /home/ubuntu/opennvr
sudo ./start.sh up
```

**You must use `sudo`.** `start.sh` pre-flights published ports by *binding* them as the invoking user; with `ip_unprivileged_port_start=1024` a non-root run aborts with:

> `These published ports cannot be bound on this host: 443/tcp 80/tcp`

That is a **false positive** — Docker binds them as root. Being in the `docker` group does not help.

First start takes 8–15 minutes (pulls + two locally built app images). Later starts are seconds.

**Verify:**
```bash
sudo ./start.sh status
sg docker -c 'docker ps --format "{{.Names}} | {{.Status}}"'
```
Expect 11 containers, the core/media/db/nginx ones `(healthy)`, and three one-shot init containers `Exited (0)`.

Operational tip for this whole document: **long commands must be detached** — anything over ~10 s in a tool call returns a session handle instead of output:
```bash
setsid nohup sudo -n bash run-up.sh > start.log 2>&1 < /dev/null &
tail -f start.log
```

### 3.5 First-time setup, and capturing the MFA secret

```bash
sg docker -c 'cd /home/ubuntu/opennvr && docker compose -f docker-compose.yml logs opennvr_core' | grep -i 'setup token'
```

Then, against the core API:
```bash
curl -s -X POST http://127.0.0.1:8000/api/v1/auth/first-time-setup \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<choose ≥8 chars>","setup_token":"<from the log>"}'
```

**The response contains `mfa_secret` and `mfa_qr_uri`, shown ONCE.** Setup auto-enrols TOTP; lose the secret and you cannot log in. Store it with the password in `ADMIN_CREDENTIALS.txt` (mode 600).

Recovery if you lost it (the value is Fernet-encrypted in the DB; the key is in the container env):
```bash
CT=$(sg docker -c 'docker exec opennvr_db psql -U opennvr_user -d opennvr_db -tAc "select encrypted_mfa_secret from users where id=1;"' | tr -d '[:space:]')
sg docker -c "docker exec -i -e CT='$CT' opennvr_core python -" <<'PY'
import os
from cryptography.fernet import Fernet
print(Fernet(os.environ["CREDENTIAL_ENCRYPTION_KEY"]).decrypt(os.environ["CT"].encode()).decode())
PY
```

Note the `admin` row is seeded by `scripts/init_db.py` with `password_set=false` — that placeholder is what "arms" the token. Setup is pending while any row has `password_set=false`.

### 3.6 Camera discovery — probe, never guess

1. **Ports/banners.** Scan 554, 80, 443, 8000, 34567, 3702. Read HTTP `Server` and `WWW-Authenticate`.
2. **Path sweep by raw RTSP `DESCRIBE`** over TCP: `200` exists · `401` exists, needs auth · `404 Stream Not Found` wrong path.
3. **Read the SDP** the `200` returns (codec, tracks, `Content-Base`).
4. **Prove it plays** — `SETUP` + `PLAY` (TCP interleaved) and count arriving RTP bytes. *A describable stream is not necessarily a flowing one.*

The three reference cameras (HOEM `Device_c5`, firmware `VH1.0.0.22`, MAC OUI `00:0f:0d`) answered only on the **bare root**:

```
rtsp://<camera-ip>:554/          # no path, no credentials
  track1 -> H264/90000, packetization-mode=1, profile-level-id=4D0028  (Main@L4.0)
  track2 -> vnd.onvif.metadata/90000 (recvonly)
```

All ~45 common vendor paths (Hikvision `/Streaming/Channels/101`, Dahua `/cam/realmonitor?channel=1&subtype=0`, Xiongmai `/user=admin&password=…&channel=1&stream=0.sdp?`, `/onvif1`, `/live/ch0_0`, `/11`, `/av0_0`, …) returned 404.

**Security finding:** these cameras accept RTSP **unauthenticated**, while HTTP :80 requires Basic (realm `IP_Camera`). Anyone on the LAN can pull the feeds — set a camera password. Their RTCs are also years stale (no NTP); harmless for streaming, relevant for on-camera timestamps.

### 3.7 Registering cameras

Production and test stacks differ only in how you obtain a token.

```bash
POST /api/v1/cameras/
{
  "name": "Cam 81", "description": "ONVIF NetworkVideoTransmitter",
  "ip_address": "192.168.1.81", "port": 554,
  "rtsp_url": "rtsp://192.168.1.81:554/",
  "manufacturer": "HOEM", "model": "Device_c5",
  "firmware_version": "VH1.0.0.22", "serial_number": "000F0D2A0552"
}
```

**Verify a camera properly — four independent checks, not just the create call:**
```bash
GET /api/v1/cameras/                        # status should be "provisioned"
GET /api/v1/cameras/<id>/mediamtx-status    # path_active: true
GET /api/v1/cameras/<id>/snapshot           # 200 + JPEG bytes (check for FF D8!)
docker logs --tail 40 opennvr_detect_pipeline | grep 'started worker'
ls /home/ubuntu/opennvr/recordings/cam-<id>/
```

**API shape gotchas (each cost real time):**
- `GET /api/v1/cameras/` returns `{"cameras": [...], "total": n}` — **not** `items`, not a bare list.
- **`POST /api/v1/cameras/?force=true` soft-deletes any existing camera with the same IP** (`is_active=false`, `deleted_at` set). It is not merely a duplicate-guard bypass. Recover via Settings → Deleted Cameras (`/api/v1/cameras/deleted`).
- An **unauthenticated** `/snapshot` returns a **30-byte 401 JSON body** that looks like a tiny image. Always assert byte count and the JPEG magic.

### 3.8 Recordings: location, retention, and the surprise

```
/app/recordings/cam-<id>/YYYY-MM-DD/HH/MM-SS-ffffff.mp4      (inside the core container)
/home/ubuntu/opennvr/recordings/…                            (host, RECORDINGS_PATH=./recordings)
```
- fMP4, **60-second segments**, ~30 MB each (3 × 1080p ≈ **5.2 GB/hour**).
- **Directory names are UTC; file mtimes are local.** `TZ` is unset → compose falls back to UTC. Set `TZ=Asia/Saigon` to align them (existing folders stay UTC-named).
- MediaMTX never deletes (`recordDeleteAfter: 0s`); deletion is OpenNVR's retention service.

Retention lives in the DB, not `.env`:
```sql
select json_value from security_settings where key='recordings_retention';
-- {"retention_days": 1, "protect_flagged": true, "min_free_space_gb": 70}
```

Here the **free-space rule dominates**: every ~2.8 h the disk crosses the 70 GB line and the oldest 500 files (~14.5 GB) are purged, leaving only **~2 hours** of footage. "My recordings disappeared" is therefore expected behaviour, not corruption. Levers, best first: substreams (~8× more history), lower `min_free_space_gb` (~+9 h per 50 GB), bigger disk.

### 3.9 TLS with Let's Encrypt

**Pre-flight two facts or don't start:** DNS must point at your WAN IP, and **port 80 must reach this host from the internet** (verify externally — the nginx container owns :80).

```bash
sudo apt-get install -y certbot

sudo certbot certonly --standalone -d a1.sifu.art \
  --preferred-challenges http \
  --pre-hook  "docker stop opennvr_nginx" \
  --post-hook "docker start opennvr_nginx" \
  --non-interactive --agree-tos --register-unsafely-without-email
```

Why standalone + hooks: the edge is a **container** whose config is a repo-tracked single-file bind mount, so `--nginx` is impossible and `--webroot` would mean editing repo config. Standalone + stop/start touches nothing of yours — and the container's `unless-stopped` policy is what lets `docker stop` stick.

**Deploy** (`nginx-certs-init` skips generation when files exist, so replacement is durable):
- installed as **both** `/usr/local/bin/opennvr-deploy-cert.sh` and `/etc/letsencrypt/renewal-hooks/deploy/opennvr-nginx-cert.sh`;
- it backs up the original self-signed pair once, installs fullchain+privkey into `./nginx-certs`, reloads nginx, **verifies what 443 actually serves**, and falls back to `docker restart opennvr_nginx` if the reload didn't take.

Both failure modes it guards against were observed: the first `certonly` ran the pre/post hooks but **not** the deploy hook (run it manually once), and a bare `nginx -s reload` immediately after the post-hook restarted the container **did not** pick up the new cert.

**Verify:**
```bash
echo | openssl s_client -connect 127.0.0.1:443 -servername a1.sifu.art -showcerts 2>/dev/null | grep -E '^ *[0-9] s:|Verify return code'
curl -sS --resolve a1.sifu.art:443:192.168.1.4 -o /dev/null -w 'http=%{http_code} verify=%{ssl_verify_result}\n' https://a1.sifu.art/
sudo certbot renew --dry-run     # must print "all simulated renewals succeeded"
systemctl is-enabled certbot.timer
```

Notes: `certbot renew` sleeps a random 0–60 s first (not a hang). We registered **without an email** — add one: `sudo certbot update_account -m you@example.com`. Once the LE cert is in place, **`https://192.168.1.4/` will warn** (no IP SAN) — expected and unavoidable for private IPs.

### 3.10 Live view / WebRTC ICE hosts (what decides whether video appears)

MediaMTX must advertise an ICE host the browser can reach. Resolution order:

```
security_settings.webrtc_ice_hosts   (DB, JSON array, persisted)
      +  MEDIAMTX_WEBRTC_HOSTS       (.env seed)
      -> applied by MediaMTX's runOnInit startup hook
      -> GET /api/v1/mediamtx/startup/hook   (header: X-MTX-Secret: <MEDIAMTX_SECRET>)
      -> MTX_WEBRTCADDITIONALHOSTS
```

Three constraining facts:
1. **Hostnames are rejected.** `services/webrtc_ice_host_service.py: is_advertisable()` calls `ipaddress.ip_address()` and returns `False` on `ValueError`. Proven in-container: `a1.sifu.art → False`, `27.74.119.56 → True`, `172.28.0.5 → False`. So neither `MEDIAMTX_WEBRTC_HOSTS=<domain>` nor `MTX_WEBRTCICEHOSTNAT1TO1IPS=<domain>` works — ICE candidates are IP literals, and DDNS cannot be one.
2. **nginx sets `X-Server-Addr: $server_addr` itself**, so the built-in "learn" path can only ever learn the LAN IP; it cannot rescue an external browser.
3. There is **no API** to set ICE hosts.

Production value: `MEDIAMTX_WEBRTC_HOSTS=192.168.1.4,27.74.71.227` (LAN + WAN).

Because the WAN IP is dynamic, a timer keeps it in sync:

| Artifact | Purpose |
|---|---|
| `/usr/local/bin/opennvr-ice-sync.sh` | resolve `a1.sifu.art` via 1.1.1.1 → validate public IPv4 → upsert `security_settings.webrtc_ice_hosts` → trigger the hook from inside the MediaMTX container |
| `/etc/systemd/system/opennvr-ice-sync.{service,timer}` | every 2 min, `Persistent=true` |
| `/var/log/opennvr-ice-sync.log` | one line per actual change; silent when steady |

**Verify the whole chain:**
```bash
sg docker -c 'docker exec opennvr_mediamtx printenv' | grep MTX_WEBRTCADDITIONALHOSTS
sg docker -c 'docker logs opennvr_core' | grep 'Applied WebRTC ICE hosts'
systemctl is-active opennvr-ice-sync.timer
```

**Router prerequisites:** forward 80 and 443 (externally verified), plus **8189 UDP** (TCP as fallback) to 192.168.1.4. Forwarding TCP only is a silent failure.

**Always test from off-LAN** — phone on cellular, Wi-Fi off. Testing from inside the LAN proves nothing, because the LAN candidate works there either way. This is exactly how a broken live view stayed hidden.

---

## 4. Code development process — the `/grid` feature

### 4.1 Repository and branch model

| Item | Value |
|---|---|
| Fork | `github.com/NguyenIvan/opennvr` (checkout: `/home/ubuntu/working`) |
| Branch | `main`, **4 local commits, unpushed** |
| Base | `34dcf03c` |
| Commits | `825f70b8` persistentRetry · `fa4c8bc4` returnTo after login/MFA · `46c228b0` slot resolution + kiosk hooks · `6e7aefb4` chromeless /grid view |
| Plan | `GRID_VIEW_BUILD_TEST_PLAN.md` (gates G0–G5) |
| Upstream | `github.com/open-nvr/open-nvr` — a fork **cannot** push to `ghcr.io/open-nvr/core` |

Before any push: `git branch feat/grid-view` and **do not push or reset `main`**. Upstream CI runs typecheck, lint, build and a PR image build; check CONTRIBUTING.md for a CLA (unverified).

### 4.2 What each commit does (features)

1. **`825f70b8` persistentRetry** — opt-in retry for unattended live tiles, so a kiosk wall recovers instead of dying on a dropped WHEP session.
2. **`fa4c8bc4` returnTo** — post-login/MFA navigation returns you to the page you originally requested (app-wide behaviour change to the post-login redirect).
3. **`46c228b0` slots/hooks** — resolves which camera occupies which tile, plus kiosk hooks (idle badge fade, cursor hide).
4. **`6e7aefb4` /grid view** — the chromeless multi-camera grid page.

### 4.3 Gates G0–G5 as actually run

Run in order and **stop at the first failure**. Token discipline: redirect long output, read only tails, lint with `--quiet`.

| Gate | What it checks | Result here |
|---|---|---|
| **G0 Preflight** | 4 commits present; only tool dirs untracked; docker/compose present; probe the reference plan's unverified claims | **PASS** |
| **G1 CI** | `npm run typecheck && lint --quiet && build`; a `GridView-*.js` chunk exists | **PASS** — `typecheck=0 lint=0 build=0`, `GridView-DCrx9-aU.js` |
| **G2 Functional** | `python tests/e2e/run.py -m ui` | **deferred** — Playwright lives *inside* the e2e container; no host install needed |
| **G3 Build + local run** | `docker build -t ghcr.io/open-nvr/core:grid-1 .` then compose up | **FAIL** (environment — see below) |
| **G4 HTTP smoke** | `/grid` and `/` both 200 with **identical** index.html | **PASS** later on the test stack (md5 `dd11fc57efd1903906180ba8581d5bc2`) |
| **G5 Human** | real devices, substream paths, outage recovery, iPhone Safari, kiosk soak | **human only** |

**G3's failure was environmental, not code:** `/home/ubuntu/working` had no `.env`, so compose aborted with `required variable INTERNAL_API_KEY is missing a value`. Immediately behind it was a second blocker: the compose file hardcodes `container_name: opennvr_core` — the name the **live** NVR owns. I caught that with `up -d --dry-run` and deliberately did not execute it.

**G0's claim-checking paid off.** The reference plan asserted things that were wrong or unverified: `AGENT_LIVE_USE_SUBSTREAM` **is** an env var (documented in `server/.env.example`) but is **not** wired through `docker-compose.yml`; `start.sh` contains no `pull`; and the container-name collision above was never mentioned.

### 4.4 The e2e harness

`tests/e2e/run.py` drives a **real, isolated stack**. Its compose invocation is the key to everything:

```bash
docker compose -p opennvr-e2e --env-file tests/e2e/.artifacts/e2e.env \
  -f docker-compose.yml -f docker-compose.fakecams.yml -f docker-compose.e2e.yml  <cmd>
```

- `docker-compose.e2e.yml` **renames every container** to `opennvr_e2e_*` and remaps ports (nginx 20080/20443, core 28000) so it can run **alongside production**. Its own comment explains why: `container_name` is absolute, so two projects collide.
- The runner executes pytest **inside** a container built from `mcr.microsoft.com/playwright/python:v1.55.0-noble` — never install browsers on the host.
- `tests/e2e/.artifacts/e2e.env` holds throwaway secrets (own DB name, own Docker subnet 172.29.0.0/16).
- Flags: `--fresh` (wipe DB; needed to re-exercise first-time setup), `--down` (teardown).

**Observed result** (`grid-1`, git `6e7aefb4-dirty`, core healthy):
```
2 failed, 102 passed, 1 skipped, 65 deselected in 636.91s
FAILED tests/ui/test_live.py::test_an_empty_grid_says_so[chromium]      # "NO CAMERA" chip never visible (30s)
FAILED tests/ui/test_alerts.py::test_an_alarm_can_be_acknowledged_by_clicking[chromium]
                                                                       # unacked count stuck at 1 for 90 attempts
```
Both are genuine product findings, not flaky infrastructure. Detection/LPR tests self-skip without real footage (the fake rig is drawn rectangles; YOLO won't classify those). Full report: `tests/e2e/.artifacts/runs/report.md` plus a per-failure `ISSUE.md`.

**Teardown trap:** `fakecams` is profile-gated, so `down` without `--profile fakecams` leaves `opennvr_e2e_fakecams` behind — `--remove-orphans` will not catch a service that is merely disabled:
```bash
docker compose -p opennvr-e2e --env-file tests/e2e/.artifacts/e2e.env \
  -f docker-compose.yml -f docker-compose.fakecams.yml -f docker-compose.e2e.yml \
  --profile fakecams down --remove-orphans
```

### 4.5 Building and pinning your own image

```bash
cd /home/ubuntu/working
docker build -t ghcr.io/open-nvr/core:grid-1 .          # ~486 MB, several minutes
```

**`CORE_TAG` keys more than the core.** `docker-compose.yml:372` also uses it for detect-pipeline, which has no `grid-1` tag — pin both:
```bash
CORE_TAG=grid-1 DETECT_PIPELINE_IMAGE=ghcr.io/open-nvr/detect-pipeline:latest \
  docker compose up -d
```

**The `CORE_TAG` trap, in bold, because it will bite you:**
> `CORE_TAG=main` is **exported in this machine's shell environment**. In Compose, **shell env beats `.env`**. So a plain `docker compose up -d` recreated the core as `ghcr.io/open-nvr/core:main` — the upstream image **without your commits** — even though `.env` said `CORE_TAG=grid-1`.
>
> Robust fix, in order: (1) use the override file, whose explicit `image:` beats both — `docker compose -f docker-compose.yml -f docker-compose.grid.yml up -d`; (2) always prefix `CORE_TAG=grid-1 …`; (3) keep `CORE_TAG=grid-1` in `.env` too (covers shells that don't inherit it).

Deploy/rollback: tag a fixed version (never `latest`), ship via `docker save | ssh host docker load` or your own registry, then `docker compose up -d opennvr-core`. Rollback = set the tag back and recreate; frontend-only, no data migration. After deploy, log out and back in once (the returnTo change is app-wide); kiosk browsers may need one hard reload (PWA service worker).

### 4.6 Running the test stack (what "testing the grid" looks like)

```bash
cd /home/ubuntu/working
cp .env.example .env && ./scripts/generate-secrets.sh --write   # its OWN .env; never production's
CORE_TAG=grid-1 DETECT_PIPELINE_IMAGE=ghcr.io/open-nvr/detect-pipeline:latest docker compose up -d
docker compose logs -f --tail=20 opennvr-core
```

Then:
- **Login:** if setup is pending the core prints a token; complete it and **capture the MFA secret**.
- **Cameras:** the repo's own `scripts/fakecams/register_fake_cameras.py` shows the passwordless route — mint a token directly:
  ```python
  sys.path.insert(0, "/app/server"); os.chdir("/app/server")
  from core.auth import create_access_token      # mint {"sub": "<username>"} for an active superuser
  ```
  Run it with `docker exec -i opennvr_core python -`; the core API is at `http://127.0.0.1:8000/api/v1`.
- **Certificate:** a fresh stack regenerates its **own self-signed** cert (`CN=opennvr-ui`, SANs `opennvr, opennvr.local, localhost, 127.0.0.1, ::1`) — your domain will mismatch. Fix by copying the production LE cert in and reloading:
  ```bash
  sudo cp /home/ubuntu/opennvr/nginx-certs/server.crt /home/ubuntu/working/nginx-certs/server.crt
  sudo cp /home/ubuntu/opennvr/nginx-certs/server.key /home/ubuntu/working/nginx-certs/server.key
  sudo chown 1000:1000 /home/ubuntu/working/nginx-certs/server.crt /home/ubuntu/working/nginx-certs/server.key
  docker exec opennvr_nginx nginx -t && docker exec opennvr_nginx nginx -s reload
  ```
- **Live view:** ensure `MEDIAMTX_WEBRTC_HOSTS` is **uncommented and set** (`192.168.1.4,<WAN>`), recreate, then confirm the core logged `Applied WebRTC ICE hosts`.

---

## 5. Challenges catalogue (symptom → cause → fix)

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Launcher aborts: "ports cannot be bound: 443, 80" | `start.sh` probes ports as the invoking user; `ip_unprivileged_port_start=1024` | run the launcher with `sudo` |
| 2 | Setup token rejected after entering it | token is one-time and already consumed; the `admin` row is the `password_set=false` placeholder | check `select count(*) from users where password_set=false`; complete setup properly |
| 3 | "Correct" MFA code rejected | account **locked** (HTTP 423) after failures, or authenticator clock skew | clear `failed_login_attempts/locked_until`; set device time to automatic |
| 4 | Verify button circles back with **no error** | SPA swallows the 401 from `/auth/login-json` and re-renders the prompt | read the server status (it *is* 401/423); UI defect worth filing |
| 5 | Can't re-enrol TOTP while locked out | `/auth/mfa/setup` is bearer-protected | clear `mfa_enabled/encrypted_mfa_secret` in the DB, log in, re-enrol via UI |
| 6 | Snapshots work but Live View spins | ICE candidate unreachable | see §3.10 — advertise a reachable **IP literal** |
| 7 | Live view fails even on the LAN | `MEDIAMTX_WEBRTC_HOSTS` **commented out** → zero candidates advertised | uncomment + set; recreate mediamtx/core; restart mediamtx |
| 8 | Live view fails only from outside | candidate is the LAN IP, or WAN IP stale, or UDP 8189 not forwarded | LAN+WAN in the host list; ice-sync timer; forward UDP 8189 |
| 9 | Domain shows "Not Secure" | cert has no SAN for the domain (fresh stack's self-signed) | install a cert that covers it (§3.9 / §4.6) |
| 10 | Recordings vanish after ~2 h | retention's `min_free_space_gb: 70` + 5.2 GB/h growth | substreams / lower threshold / bigger disk (§3.8) |
| 11 | Plain `compose up` silently downgraded the core image | ambient `CORE_TAG=main` beats `.env` | override file / explicit `CORE_TAG=grid-1` (§4.5) |
| 12 | `compose up` in the fork fails on INTERNAL_API_KEY | no `.env` in that checkout | seed one (§4.6) |
| 13 | Two projects can't start — name in use | absolute `container_name` in compose | use the e2e overlay's renaming, or stop the other stack |
| 14 | `opennvr_e2e_fakecams` survives teardown | profile-gated services are not orphans | pass `--profile fakecams` to `down` |
| 15 | A 30-byte "image" from /snapshot | unauthenticated request → tiny 401 JSON | send a Bearer token; assert size + `FF D8` |
| 16 | Adding a camera silently deactivated another | `?force=true` soft-deletes by IP | use `force` only to replace; restore from Deleted Cameras |
| 17 | A renewal stops the wrong nginx | certbot hooks reference container names **by name**, which both stacks share | run one stack at a time |
| 18 | Long tool commands return no output | over-budget call returns a session handle | run detached with a log, then poll |

### Deep dive: why "Online + Recording" coexists with a spinner
The camera→MediaMTX ingest path and the MediaMTX→browser path are independent. Snapshots and recordings prove the first; the spinner indicts the second. Always separate them before changing anything: if `mediamtx-status` says `path_active: true` **and** a snapshot returns a real JPEG, the problem is **ICE candidate / NAT / firewall** — never the camera.

---

## 6. Maintenance plan

### 6.1 Routine schedule

**Daily (2 minutes)**
```bash
sudo ./start.sh status                              # or: docker ps — expect all healthy
systemctl is-active opennvr-ice-sync.timer certbot.timer
df -h /                                             # recordings grow ~5.2 GB/h
ls /home/ubuntu/opennvr/recordings/ | tail -1
```

**Weekly**
- `sg docker -c 'docker logs --since 24h opennvr_core' | grep -iE 'error|traceback' | tail`
- `find /home/ubuntu/opennvr/recordings -name '*.mp4' -mmin -10 | head` — is recording current?
- `docker logs --tail 20 opennvr_detect_pipeline | grep -i 'started worker'` — is detection alive?
- Confirm the disk-pressure purges match your expectations (they are deliberately aggressive).

**Monthly**
- `sudo certbot renew --dry-run` — proves the port-80 path and the hooks still work.
- `curl -s ifconfig.me` vs `dig +short a1.sifu.art` — if they differ, DDNS or the ICE sync is stale.
- Copy `ADMIN_CREDENTIALS.txt` and `.env` into your secrets store (off-host).
- `docker image prune -f` — **never** `-a` while `core:grid-1` matters.

**Quarterly**
- Review camera firmware/passwords (§6.5).
- Re-baseline capacity: current rate × desired retention vs free space.
- Test a restore — an untested backup is not a backup.

### 6.2 Health checks that catch the silent failures

| What | Command | Healthy looks like |
|---|---|---|
| Edge TLS | `curl -sS --resolve a1.sifu.art:443:192.168.1.4 -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://a1.sifu.art/` | `200 0` |
| ICE host advertised | `docker logs opennvr_core \| grep 'Applied WebRTC ICE hosts'` | a list containing your LAN **and current WAN** IP |
| Camera path live | `GET /api/v1/cameras/<id>/mediamtx-status` | `path_active: true` |
| Frames decoded | `GET /api/v1/cameras/<id>/snapshot` | `200` + tens of KB + `FF D8` |
| Recording | `ls recordings/cam-<id>/$(date -u +%F)/` | recent `.mp4` files |
| Live view (the real test) | phone, **cellular**, Wi-Fi off | video, no spinner |

### 6.3 Backups and restore

Back up, in order of importance:
1. `/home/ubuntu/opennvr/.env` and `ADMIN_CREDENTIALS.txt` — **without them the stack is not recoverable**, and `CREDENTIAL_ENCRYPTION_KEY` can never be regenerated.
2. The PostgreSQL volume (`opennvr_opennvr_db_data`) — cameras, users, settings, retention policy.
3. `/home/ubuntu/opennvr/nginx-certs/` and `/etc/letsencrypt/`.

Restore = bring up a clean stack with the same `.env`, restore the volume, restart. Practise once on the test stack before you need it.

### 6.4 Operating the two stacks safely

Pick exactly one:
1. **Stop production first** — `cd /home/ubuntu/opennvr && sudo ./start.sh down`; verify ports 80/443/8000/8189 are free; then bring the other up.
2. **Use the e2e overlay** (recommended; no downtime) — it renames everything to `opennvr_e2e_*` and remaps ports (§4.4).
3. Accept downtime windows knowingly.

Never let two cores share a database: the grid build runs alembic migrations at boot, so pointing a test core at production's volume would migrate live schema with unreviewed code. Project-prefixed volumes (`opennvr_*` vs `working_*`) protect you **only** if you don't deliberately cross them.

### 6.5 Security posture and what to fix next

1. **Cameras accept unauthenticated RTSP** — anyone on the LAN can watch. Set a camera password.
2. **The UI is reachable from the internet on 443** (router forward). It is protected by TLS + MFA, but the access log is full of bot scans (`.git/config`, `/admin/config.php`, ISAPI `sessionLogin`, `/HNAP1/`). Restrict by IP at the router, or put it behind a VPN/Tailscale.
3. **No email on the ACME account** — no expiry warnings. `certbot update_account -m`.
4. `ufw` is inactive **and irrelevant**: Docker publishes through its own iptables chains (`DOCKER-USER`) and bypasses ufw. Restrict at the router or in `DOCKER-USER`.
5. Secrets hygiene: `.env` and the credentials file stay mode 600, never in git, never in chat.

### 6.6 Upgrade and rollback

```bash
# production
cd /home/ubuntu/opennvr
sg docker -c 'docker compose pull && ./start.sh up'
```
- Migrations run automatically at core boot — **back up the DB first**.
- Pin versions; never `latest` for anything you cannot re-pull.
- Rollback: restore the previous image tag (or the DB dump) and recreate the core. Frontend-only changes need no data migration.
- If a deploy breaks login: the post-login redirect changed app-wide — log out and in once, and hard-reload kiosk browsers.

### 6.7 Capacity planning

Current: 3 × 1080p main streams ≈ **5.2 GB/hour**, with retention effectively capped at ~2 h by the 70 GB free-space floor. "Keep a week" needs ~870 GB **and** a lower `min_free_space_gb`. The cheapest win by far is a **substream** (≈8× less storage, ~5× less detection CPU) — these cameras expose none over RTSP, so that requires ONVIF `GetStreamUri` profile 2 **with the camera's HTTP credentials**.

---

## 7. Final note

**The pattern behind nearly every failure here was the same:** *a system reporting success while the part that mattered was silently absent.* A container "healthy" with no ICE host; a camera "provisioned" with an unreachable candidate; a login returning 401 while the UI shows nothing; a compose file whose image tag was quietly overridden by an environment variable; recordings vanishing on a retention rule nobody read. If you take one habit from this document, make it: **verify the user-visible outcome, not the status field.** "Healthy" is not "working".

**Handover checklist**
- [ ] `.env` + `ADMIN_CREDENTIALS.txt` copied to the secrets store, and the MFA secret enrolled in a real authenticator.
- [ ] Router forwards 80, 443 and **8189/UDP** to 192.168.1.4.
- [ ] `certbot.timer` active; ACME account has an email; `renew --dry-run` green.
- [ ] `opennvr-ice-sync.timer` **active** (it is currently **inactive**).
- [ ] Only one stack running; the other documented as stopped.
- [ ] Cameras given real passwords — the feed is no longer anonymous on the LAN.
- [ ] A restore has been practised once.

**Open items at the time of writing (2026-10-07)**
1. **Production is down** — only the test stack (`working`) runs; all `opennvr_*` container names currently belong to it. Restore with `cd /home/ubuntu/opennvr && sudo ./start.sh up`, then `sudo systemctl start opennvr-ice-sync.timer`.
2. **`opennvr-ice-sync.timer` is inactive** — external live view will drift when the WAN IP next changes.
3. **Two e2e UI failures remain unfixed** — the silent empty-grid state and alert ack-by-click (§4.4). Neither is infrastructure.
4. **The grid commits are unpushed** on the fork's `main`; branch before pushing.
5. **`CORE_TAG=main` is ambient in this shell environment** — the most likely cause of "my grid changes disappeared".
6. **`certbot.timer` fires at 02:04** and its hooks act on container names by name — whichever stack owns `opennvr_nginx` gets stopped and reloaded.

*Keep this document next to the system it describes. When you fix something painful, add it to §5 — the catalogue is the most valuable part of this file.*
