# BUILD & TEST PLAN: `/grid` view (openclaw runbook)

Scope: build, verify and (optionally) deploy the four grid commits already on local `main`:
`825f70b8` persistentRetry, `fa4c8bc4` returnTo, `46c228b0` slots/hooks, `6e7aefb4` /grid view (base `34dcf03c`).
Code is already reviewed (grid-reviewer PASS x4). Do NOT re-read GRID_VIEW_PLAN.md or the source. Do NOT change code; report failures.

## Token rules (apply to every gate)
1. Redirect long output to `/tmp/<gate>.log`; read only `tail -n 15` or `grep -n -i "error\|fail" | head`.
2. Lint with `--quiet` (plain lint prints ~729 pre-existing warnings: noise).
3. Skip `npm ci` if `app/node_modules` exists (lockfile unchanged).
4. Stop at the first failing gate. Report ONE line: `Gn FAIL: <failing line>`. No fixes across gates.
5. Success output is one line per gate: `Gn PASS`.

## Corrections to the reference plan (why this plan differs)
- Its config claims (CORE_TAG/image name, AGENT_LIVE_USE_SUBSTREAM env var, ci.yml steps, Vite proxy var, publish tags, CLA, `start.sh up`) were read, not run. G0 greps each one first.
- `AGENT_LIVE_USE_SUBSTREAM` may not be an env var: the plan calls it a server setting (`agent_live_use_substream`). If it lives in DB/settings UI, the compose override does nothing. Check before building around it.
- `CORE_TAG=x docker compose up` applies to that one command only; the next plain `up` reverts. Pin the tag in an override file or `.env`.
- The repo has e2e tooling (`tests/e2e/run.py`, `docker-compose.fakecams.yml`, `docker-compose.e2e.yml`) and `docs/UI_GUIDELINES.md` asks for `python tests/e2e/run.py -m ui` on UI changes. The reference ignores it, and requires real cameras/devices for everything.
- No gate order or stop condition in the reference; an agent burns tokens past an early failure.
- Service workers do not register on pages with certificate errors, so a self-signed LAN host cannot test the PWA stale-index risk. Use localhost or a trusted cert.
- The reference never mentions git state: commits are local and unpushed.

## G0 Preflight (2 calls, ~1k tokens)
```bash
cd /home/ubuntu/working && git log --oneline 34dcf03c..HEAD && git status --short
docker version --format '{{.Server.Version}}' && docker compose version --short
grep -rn -i "agent_live_use_substream" server docker-compose*.yml .env* 2>/dev/null | head -5
grep -n "CORE_TAG\|image:" docker-compose.yml | head
grep -n "run:" .github/workflows/ci.yml | head
grep -n "pull" start.sh | head -3
```
PASS: 4 commits; only `.claude/`, `.openclaw/` untracked.
Record: (a) is the substream flag an env var or a DB/settings value; (b) does `start.sh up` pull images; (c) ci.yml steps. If Docker is missing, run G1 only and report.

## G1 CI gate (~1 min)
```bash
cd app && npm run typecheck && npm run lint -- --quiet && npm run build > /tmp/g1.log 2>&1; tail -n 5 /tmp/g1.log; ls dist/assets | grep GridView
```
PASS: exit 0 and a `GridView-*.js` chunk exists.

## G2 Automated functional check (optional; replaces human steps)
Run `python tests/e2e/run.py -m ui` (fake cameras) for regressions. If the harness easily supports it, add ONE Playwright test:
- logged out `/grid?cameras=2,1` -> login -> back on the same URL; direct `/login` -> `/`
- `?cameras=1,999` shows "Camera 999 not found"
- viewport 390x844 -> 844x390: grid columns 2 -> 3, zero new `/whep` POSTs
- `document.documentElement.scrollWidth <= innerWidth`
Skip if setup is heavy; those checks stay in G5.

## G3 Image build + local run
```bash
docker build -t ghcr.io/open-nvr/core:grid-1 . > /tmp/g3.log 2>&1; tail -n 15 /tmp/g3.log
```
Create an UNTRACKED `docker-compose.grid.yml` overriding `opennvr-core` image to `ghcr.io/open-nvr/core:grid-1` (plus the substream env var only if G0(a) says it is an env var). Then:
```bash
docker compose -f docker-compose.yml -f docker-compose.grid.yml up -d opennvr-core
```
Never run `docker compose pull`; do not run `start.sh up` if G0(b) says it pulls. Do not commit the override file.

## G4 HTTP smoke
GET `/grid` and `/`: both 200 and identical `index.html` (`md5sum`) = SPA fallback serves the new route.

## G5 Human only (agent skips)
Real-device checks: substream paths end `-sub/whep` (only if substream is enabled and cameras have substream URLs), MediaMTX outage recovery (~36s after restart), idle badge fade/cursor hide, iPhone Safari (autoplay, rotation, notch), kiosk 10-min CPU soak (<40%). Plus any G2 items not automated. Use HTTPS on a trusted cert (wake lock needs a secure context). Kiosk: `chromium --kiosk https://<host>/grid`.

## Before any push / PR
- `git branch feat/grid-view` first; do NOT push or reset `main`.
- Upstream CI runs typecheck, lint, build and a PR image build. Check CONTRIBUTING.md for a CLA (unverified).

## Deploy / rollback
- Fork or self-host: the upstream publish workflow pushes to `ghcr.io/open-nvr/core`, which a fork cannot write to. Tag a fixed version (`grid-1` or git sha), ship via `docker save | ssh host docker load` or your own registry, pin the tag in `.env`/override (never `latest`), `docker compose up -d opennvr-core`.
- Upstream: after merge, CI publishes `:main`, `:latest`, `:sha-...`; prod then pulls.
- Rollback: set the tag back and recreate `opennvr-core`. Frontend-only, no data migration.
- After deploy: log out and in once (P2 changed post-login redirect app-wide); kiosk browsers may need one hard reload (PWA service worker).
- AGPL: serving a modified build to others over a network requires offering them the source.

## Models
Gates G0-G4 are mechanical: a mid-tier model is enough; escalate only when a gate fails and needs debugging. No review subagent needed. If grid-reviewer is reused, raise its `maxTurns` above 15 (it hit the limit on two of four reviews and each resume re-sends context) or tell it to give a verdict early.
