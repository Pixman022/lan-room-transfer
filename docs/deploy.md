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
- `RENDER_EXTERNAL_URL`: injected by Render; used for exact WebSocket Origin enforcement
- `PUBLIC_ORIGIN` (optional): override only if using a verified custom domain; the value must be the `https://` origin

## Known blockers before calling this production

1. Route heuristic is **not** proof of LAN-only transport, especially VPN/public IPv6/hidden address cases; fail closed when unverifiable and run on-device network tests.
2. Browser receives a maximum of 32 MiB per file in this POC; automatic save and directory-picker behavior are not complete.
3. Four-digit codes are guessable; anonymous room membership exposes presence/metadata to anyone who obtains the code.
4. Render Free can sleep or restart; current rooms are in memory and disappear on process restart.
5. No complete production-grade abuse prevention or persistent multi-instance session coordination.

For browser compatibility and real-device validation, use `docs/test-matrix.md`.
