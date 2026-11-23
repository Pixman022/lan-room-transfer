# Deploy and verify LAN Room (research POC)

## Architecture

- Repository: `Pixman022/lan-room-transfer` (independent of Fresnica)
- Hosting: a single HTTPS Render web service (`render.yaml`)
- Public URL: assigned by Render during deployment, **not** GitHub Pages
- `server.py`: serves `/`, `/static/*`, `/api/suggest-code`, `/health`, `/ws`
- File bytes: WebRTC DataChannel between browsers. The signalling process never intentionally relays file payloads.

GitHub Pages serves static assets only and cannot execute `server.py`; it is **not** a complete hosting option for this app.

## Steps after GitHub repository creation

1. Create `Pixman022/lan-room-transfer` as a **new repository** and initialize a `main` branch with a README.
2. Upload/commit the files from this source tree using the GitHub connector or `git push`. Do not include `.venv`, `__pycache__`, generated ZIPs or credentials.
3. Open https://render.com/deploy?repo=https://github.com/Pixman022/lan-room-transfer and connect GitHub to Render if prompted.
4. Review the service plan (the Blueprint proposes `free`), launch deployment, and copy the exact URL assigned by Render.
5. Check `https://<assigned-host>/health` returns `{"ok":true,"service":"signal-only"}`.
6. Open the public URL on two *different* devices on the same Wi-Fi. Verify same room code joins and device presence syncs. Then run the small-file transfer test and inspect ICE transport stats.

## Runtime settings

- `PORT`: injected by Render
- `HOST=0.0.0.0`: configured in `render.yaml`
- `RENDER_EXTERNAL_URL`: injected by Render; used for exact WebSocket Origin enforcement and to enable trusted Render ingress IP extraction for request rate limits. With this environment variable present, only `CF-Connecting-IP` (single validated IPv4/IPv6 address) is accepted as the visitor IP, otherwise the socket IP is used. Never enable this trust mode on an endpoint directly reachable without Render/Cloudflare ingress; `X-Forwarded-For` is deliberately not trusted. Validate actual production header provenance separately.
- `PUBLIC_ORIGIN` (optional): override only if using a verified custom domain; the value must be the `https://` origin

## WebSocket admission limits

The signalling server rejects more than 60 WebSocket upgrades per observed client IP in a rolling minute (HTTP 429 before WebSocket negotiation), and closes any upgraded connection that has not successfully entered a room within 20 seconds. Successful room entries cancel the deadline; ongoing transfers and normal room keepalives are unaffected. These are per-process resource limits, not distributed denial-of-service protection. Multiple devices behind a shared NAT may share the same quota.

## Check whether a commit actually deployed (2026-11-23)

A green GitHub Actions result and a merged `main` commit do **not** prove
the hosted service is running that revision. Compare the latest `main` SHA
with the commit shown under the Render service's **Deploys** page.

On 2026-11-23, `main` reached `801875d` with passing CI while the
Render service still reported `124ec0a` as Live. The Render service API
reported `autoDeploy=yes`, `autoDeployTrigger=commit` and branch `main`;
however, recent deploys had API triggers and no deploy for `801875d`.
The cause of this missing automatic trigger is **not confirmed**.

For the service owner to inspect:

1. In Render service **Settings**, confirm linked GitHub repository,
   branch `main`, Auto-Deploy = **On Commit**, and any build filters.
2. Check the Render GitHub App installation allows
   `Pixman022/lan-room-transfer`; also inspect the service's Git
   credentials in Render Settings.
3. Reconcile the Render **Events** and **Deploys** pages with the GitHub
   `main` commit and CI run. If authorization is corrected, verify a later
   normal merge triggers a deploy before calling auto-deploy restored.
4. If an immediate rollout is necessary and the GitHub integration is
   still unavailable, the service owner can use Render's **Manual Deploy →
   Deploy latest commit**. Confirm the Live SHA and `/health` afterward.
   Do not deploy a specific historical commit as a workaround.

Render references:
[deploys](https://render.com/docs/deploys) ·
[Git provider authorization](https://render.com/docs/git-provider).

## Known blockers before calling this production

1. Route heuristic is **not** proof of LAN-only transport, especially VPN/public IPv6/hidden address cases; fail closed when unverifiable and run on-device network tests.
2. The fixed 32 MiB application-side limit was removed **for experimental testing only**. Both sides still hash whole-file ArrayBuffers and the receiver buffers the entire file in memory. Large files can exhaust memory or stall, particularly on mobile; reliable 100 MiB–1 GiB support, streaming save, resume and save-location UI are **not** proven.
3. Four-digit codes are guessable; anonymous room membership exposes presence/metadata to anyone who obtains the code.
4. Render Free can sleep or restart; current rooms are in memory and disappear on process restart.
5. No complete production-grade abuse prevention or persistent multi-instance session coordination.

For browser compatibility and real-device validation, use `docs/test-matrix.md`.
