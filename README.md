# LAN Room — browser P2P file sharing (research POC)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Pixman022/lan-room-transfer)

**Deployment requires approval in your Render account; the GitHub repository itself does not host a running server.**

**Independent project. Not part of Fresnica.** Repository name is provisional and does not define the final product brand.

This is a **developer proof of concept**, not a production deployment or a verified LAN-only product. End users will access the public HTTPS site without installing or hosting a local signalling server. `server.py` serves both the UI and WebSocket signalling; the included `render.yaml` prepares the service for hosted testing. Running it locally is only for development.

## Deploy from your GitHub repository

This application **cannot run on GitHub Pages alone** because its Python WebSocket signalling server requires a running backend. For one public URL, keep the source on GitHub and host both the website and signalling server as one Render web service.

1. The separate repository is [Pixman022/lan-room-transfer](https://github.com/Pixman022/lan-room-transfer). Do not upload this project to any Fresnica repository.
2. The project source, tests, and deployment configuration are maintained in this repository.
3. Open [Deploy to Render](https://render.com/deploy?repo=https://github.com/Pixman022/lan-room-transfer), authorize the repository if prompted, then review and deploy the service described in `render.yaml`.
4. Once deployed, open the exact HTTPS URL shown in **your Render dashboard**. Two devices on the same LAN should access the same URL. Do not assume any particular Render URL before it has been created.
5. Check `/health` on that HTTPS URL, then follow `docs/test-matrix.md` with two physical devices.

Render sets `RENDER_EXTERNAL_URL` automatically, which this app uses to enforce the WebSocket `Origin` check when `PUBLIC_ORIGIN` is not set. The server binds to `0.0.0.0` under Render; do not expose your local test server directly to the internet.

**Security limitation:** Publishing the signalling service exposes room lookup to the internet. Four-digit room codes are easy to guess; the current per-IP limits are not a production abuse defence. Also, the WebRTC route heuristic can be wrong about VPNs and complex networks. Use nonsensitive test files only until real-device security testing has passed.

The Render Free web-service plan may sleep during inactivity and wake with a delay. The GitHub repository hosts **source code**, while the public running app lives on Render. See [deployment notes](docs/deploy.md).

## Implemented now

- Python `aiohttp` signalling server; a single **Enter Room** action for random 4-digit codes or user-defined 4–16 alphanumeric codes (case-insensitive)
- On first entry the code creates a room; subsequent users entering the same code join automatically with no approval. No separate create/join UI or administrator; provisional cap of 10 online members
- Initial 4-digit suggestion comes from currently unoccupied codes; **suggestions are not reserved** until entry. Room membership remains open while the room is live; custom codes are reusable but not permanently reserved
- **Immediate empty-room closure:** once the final online WebSocket member disconnects, the server releases that room and its code. If others remain online, a returning device can rejoin the existing room and, with a valid session token, resume its identity; authenticated refresh replaces the old socket instead of creating a duplicate. If everyone has disconnected, re-entering the same code creates a **new room and new member identity**, even if the browser still has an old token. Browser tabs that remain open can retain their own File objects across automatic reconnect, but interrupted transfers restart from zero. Each connection has a generation ID to reject stale ICE/SDP and old disconnect events.
- WebSocket offer/answer/ICE signalling only. File metadata and bytes never intentionally pass through the signal server. On unexpected socket loss, the browser now retries the same room with an exponential delay (1/2/4/8/15 seconds, capped at 15 seconds), keeps staged local files, and rebuilds peer connections when room entry succeeds. Manual exit disables retries. Active/queued downloads are marked interrupted and require a new request rather than unsafe byte-stream continuation. The aiohttp server continues to send native WebSocket ping frames (`heartbeat=25`). Because browser JavaScript cannot observe native pong frames, joined browsers also send a small **signal-only** `keepalive` every 20 seconds and expect a matching `keepalive-ack` before the next check. A missing ack triggers the existing reconnect path even if the browser never emits a native WebSocket `close` event. Ordinary diagnostics show heartbeat sent/ack/timeouts, disconnect and reconnect counters, plus room-entry type even with no other peers. This does **not** guarantee instant network-loss detection: background-tab timer throttling and server-side stale-socket detection can delay it. No file metadata, room credentials or bytes are carried in the keepalive messages.
- Browser WebRTC DataChannel (`iceServers: []`); restricted P2P checks normally require a selected `host/host` ICE pair. A user-approved `local host / remote prflx` exception requires a succeeded/nominated selected pair, fully connected transport and channel, and remote `ready`. If **both** addresses are masked, remote `ready` must explicitly attest to a verified selected `host/host` pair; legacy `ready` is insufficient. All relay/srflx, public/unsupported, or mismatched visible subnet paths still fail. When signalling stays connected but ICE stalls, a bounded retry protocol re-creates the peer connection (maximum four attempts: two initial offerer-direction attempts and two reversed-direction attempts) and isolates stale SDP/ICE by attempt number. **No absolute LAN-only guarantee.**
- Friendly default **English Color + Animal** name (for example `Amber Bear` or `Coral Fox`) on first visit, saved in the browser; editable on the home page or inside a room. Old automatically generated Chinese `label-1234` defaults are migrated, while user-chosen names are preserved. Name updates propagate without changing device identity. A browser refresh can restore the room using the existing single entry action
- **Warm pale-orange visual design**, white cards on a soft peach background, short labels and playful animal avatars (inspired by the visual reference supplied for this separate project)
- Room-wide ephemeral file shelf: **drop or choose files immediately after entering**—no recipient selection. All verified connected peers see shared file names and sizes, and later joiners receive the uploader's current catalog. Peers decide independently whether to **Receive** or **Receive All**. File bytes transfer only on explicit receipt over accepted direct P2P WebRTC channels. The uploader can withdraw a shared file. No file bytes or metadata are intentionally stored by the public signalling server. Shared files disappear from the room when the uploading device leaves or disconnects.
- Global one-file-at-a-time receiver queue, cancellation/retry controls and progress. Sender computes a SHA-256 digest; receiver independently verifies it before showing the **Save** link. A mismatch discards received content and enables retry. Waiting for a sender times out after 20 seconds; active transfer stalls after 30 seconds without progress (rather than 20 seconds total).
- Browser download link after receiving and SHA-256 verifying a file. **The application-side 32 MiB per-file cap has been removed for experimental testing**; there is no fixed application limit, but the receiver still buffers the whole file and both sides compute SHA-256 over a whole-file ArrayBuffer. Large transfers can exceed browser/device memory, stall or fail, particularly on mobile. No streaming download or resume yet; do **not** interpret the removal as guaranteed 100 MiB–1 GiB support.
- Desktop/mobile responsive UI draft

## Run locally — Windows PowerShell

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python server.py
```

Open **http://127.0.0.1:8765** in a browser. The page suggests a random device name and 4-digit room code; optionally edit either, then click **进入房间**. The first user with that code creates the live room; every later user with that code enters it automatically. This checks the interface and WebSocket signalling on one computer. Two tabs of the same computer with identical visible candidate addresses are rejected; if a browser hides those addresses, the restricted host-only heuristic cannot reliably distinguish such tabs. This test is not a substitute for two physical devices.

For actual two-device testing, deploy the app + signalling server behind a **trusted HTTPS origin with WebSocket (`wss://`) support**, then open the same public URL on two different devices connected to a LAN. No local server is needed for those users. Ensure `PUBLIC_ORIGIN` exactly equals the public `https://...` origin. A static GitHub Pages site alone cannot host this WebSocket signalling server.

## Optional coordinated three-device QA test (hidden in normal mode)

To test **real concurrent file bytes with one human operating A/B/C**, use the explicitly opt-in URL
`https://lan-room-transfer.onrender.com/?qa=1` **on all three browsers**. The normal URL never shows this panel. This is a local test aid, not an automatic transfer feature or a new product flow.

1. A, B and C enter the **same room**, and verify A↔B and A↔C have `canTransfer:true` in ordinary diagnostics. Keep all three tabs **foreground**: mobile/browser background throttling can delay timers.
2. **Before starting:** A shares `A_primary_64MiB.bin` or a smaller test file; B shares `B_reply_32MiB.bin` or a smaller test file. B and C must see A's file; A must see B's file.
3. On **C** select A's file in **并发验收 · 同步接收**, click **准备接收**. On **B**, select the *same* A file and click **准备接收**. On **A**, select B's file and click **准备接收**. These actions only stage local choices; no file bytes are requested yet.
4. Only on **A**, click **同步开始（只在 A 点击）** *once*. A sends a tiny `qa-start` command to B and C **only over already verified P2P DataChannels**, and all three armed browsers schedule their ordinary `acceptFile` flow after a **6-second** local countdown. Other tabs, ordinary mode, unarmed clients, stale selections or unsafe/not-ready peer links do not trigger automatic reception. There are no cloud signaling messages or file bytes in this helper.
5. Wait for all three received files to show **校验通过，点击保存**; click Save and independently compare the saved SHA-256 values to the original files. Each browser's **诊断 → 复制诊断** includes, **only in QA mode**, `qa.receiveWindows[].firstByteAfterTriggerMs` and `lastByteAfterTriggerMs`: offsets from that device's *received P2P start notification* to real `file-start`/`file-end` controls. Compare the three intervals: `max(starts) < min(ends)` suggests actual overlap. P2P control arrival latency and OS scheduling make these offsets **approximate**, not a precise synchronized clock measurement. If file bytes finish before overlap is observable, use modestly larger files only when devices have enough memory.
6. If a device does not start, inspect whether it was armed and whether its peer was still file-ready; keep the room open and copy the **ordinary (not `?debug=1`) diagnostic** from the affected two endpoints. If results are missing or timing windows do not overlap, record **pending**, not passed.

**Safety:** The QA receiver must be locally armed; the coordinator cannot choose or read files from remote devices. The test trigger itself carries only `kind` and a fixed countdown, no filenames, file bytes, credentials, or addresses. The normal per-receiver queue, SHA-256 and current selected-path safety checks remain in force. The fixed 32 MiB cap is removed for experiments, but whole-file buffering can fail on mobile; 64/32/128 MiB must not be advertised as proven size support.

## Run automated tests

```bash
python -m unittest discover -s tests -v
node --test tests/*.test.mjs
```

The offline `python tests/offline_room_ui.py` harness (Playwright/Chromium) validates device names, uploading with no peers, announcements to all verified devices, late-join catalog synchronization, withdrawal, receive controls, queue display, rename, and desktop/mobile overflow with mocked peers. Generated screenshots in `docs/*-static.png` are fixture-based UI demonstrations, not evidence of working device-to-device transfer.

The optional `tests/browser_smoke.py` requires Playwright/Chromium and a locally running server. It was not successfully run in the current isolated execution environment because Chromium's administrator policy blocks local HTTP connections. Static desktop/mobile screenshots in `docs/` were rendered without network access and do **not** constitute a functional browser test.

## What is NOT proven / NOT production-ready

1. **Restricted P2P mode (approved 2026-11-18; host/prflx option B approved 2026-11-19):** normally accept a selected `host/host` ICE pair; additionally accept a narrowly verified `local host / remote prflx` pair with connected transport, an open channel, reciprocal `ready`, and safe private/masked address evidence. If both endpoints' addresses are hidden, the remote ready must explicitly attest to a verified selected `host/host` path; it cannot prove the physical LAN. Reject `relay`/`srflx` and unsafe/unsupported or mismatched visible address paths. The app has no configured STUN/TURN and does not relay file bytes or file metadata through its cloud signalling service. **This does not prove that the network route remains on one physical LAN.** VPN or unusual routing may still carry P2P traffic outside it.
2. The user has successfully transferred files in both directions between real devices. Automatic SHA-256 verification and progress-based stall handling are newly implemented but **not yet verified on real devices**. End-to-end saved-file hash comparison and repeated-run reliability remain pending.
3. Receiving files currently buffers the **entire file** in browser memory and provides a manual **Save** link after checksum verification. There is **no fixed application-side size cap** in the experimental version, but large files can run out of memory or time out during whole-file checksum processing. Automatic default download and optional File System Access directory/file picker have **not** been implemented yet.
4. The UI has no QR joining, peer blocklist, automatic content security scanning, or persisted transfer history yet.
5. Same-code rooms are global to a single signalling process; peer names may be disclosed to other users who know/guess a code. Room code is not a password.
6. Security hardening for production (trusted proxy headers, persistent rate limiting, deployments with sticky WebSockets, load tests, CSP audit, advanced abuse controls) remains to be done.
7. Automated tests cover room/signalling/API logic, random device-name persistence logic, the route-policy heuristic and browser-controller retry logic in a Node VM stub. They do not constitute end-to-end WebRTC transfer validation. Automatic retry after real network loss and long-running mobile background recovery require field tests.

## Project structure

```text
server.py                  public signalling and static web host
public/index.html          desktop/mobile web interface
public/device-name.js      device name generation and storage
public/room-code.js        initial room-code suggestion and input validation
public/styles.css          responsive styles
public/app.js              WebRTC and file-list/queue prototype
public/route-policy.js     restricted P2P candidate-pair policy with verified host/prflx exception
public/checksum.js         browser WebCrypto SHA-256 and verification helpers
requirements.txt
Dockerfile                 container packaging for HTTPS reverse-proxied deployment
package.json               JS unit test configuration (no npm install required)
tests/test_server.py        unit + WebSocket signalling tests
tests/route-policy.test.mjs JS path heuristic tests
tests/checksum.test.mjs    SHA-256, mismatch and malformed-digest tests
tests/reconnect.test.mjs   Node VM controller tests for reconnect/backoff/manual exit, local files and stalled ICE renegotiation
tests/device-name.test.mjs  random name and persistence unit tests
tests/room-code.test.mjs    random room code and custom code validation tests
tests/offline_room_ui.py   interactive mock-peer browser checks and screenshots
tests/screenshot_static.py  compatible wrapper for the offline screenshot harness
tests/browser_smoke.py     optional live signalling Chromium smoke test (environment-dependent)
docs/limitations.md        risk register and next decisions
docs/test-matrix.md        manual field test plan
```

## Product decisions reflected in this code

- Web UI; no client app installation; no server deployment required **for end users**.
- Internet for HTTPS page/signalling; file contents transfer through accepted direct WebRTC peer connections, with no cloud relay or storage. A physical LAN-only route is not guaranteed.
- Everyone with the room code can join without approval; no owner/admin.
- One entry action automatically creates a missing room or enters an existing one. Room code suggestions are not reserved, so concurrent users could claim a suggested code before it is submitted.
- Custom code can be reused after room expires, with no permanent ownership.
- Creator departure does not close a room while other members remain connected. The last member's disconnect closes it immediately; the same code can then create a new room, but old server-side sessions and unfinished transfers are not restored.
- Verified room members see file names and sizes from online uploaders, including files shared before they joined. Each member can receive one file or all remaining files in an offer, independently of others. No checkboxes, no "receive selected".
- One active inbound file at a time per receiving browser, with progress, cancellation and retry.

See `docs/test-matrix.md` for the practical validation order before V1 development, and `docs/limitations.md` for the prioritized remaining-work backlog and the deferred Chrome–Firefox reliability issue.
