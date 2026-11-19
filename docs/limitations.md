# Technical risks and gaps (2026-11-18)

## Active project backlog (reviewed 2026-11-19)

The shipped site and repository are a **research POC**, not a production-ready or physically LAN-guaranteed file transfer product. Distinguish implemented-and-tested-in-unit-simulation from verified-on-real-devices. The user's current decision is to **defer further Chrome desktop ↔ Firefox mobile ICE reliability tuning**. Do not change the existing 2+2 negotiation policy as part of unrelated work.

### Deferred: cross-browser ICE connection reliability

**Tracked:** [GitHub issue #6](https://github.com/Pixman022/lan-room-transfer/issues/6) · **Status: deferred for later optimization**. On 2026-11-19 the user completed five single-click PC Chrome-created room → mobile Firefox join trials: automatic P2P-ready **4/5**, successful setup times **15, 35, 15, 34 s** (mean **24.75 s**, median **24.5 s**), **three** confirmed file receipts, a fourth unconfirmed, and one failed/manual-rejoin round. The failed round had no two-sided snapshot; do not assume mDNS, ICE candidate-pair resolution or timers are the root cause. Redacted per-attempt diagnostics are deployed. Future acceptance and investigation live in issue #6; no current-sprint modification is planned.

### Next work (excluding deferred ICE tuning)

| Priority | Remaining work | Actual baseline and acceptance |
| --- | --- | --- |
| P0 before public V1 | **File/receiver end-to-end QA**: same-file saved SHA-256 comparison on two real devices, both directions, Receive All sequential queue, cancellation/failed retry, source withdrawal, unexpected disconnect, 1 MiB and up-to-32 MiB memory checks | SHA-256 and queue logic exist; controller/unit/mock UI coverage passes, but these combinations and saved-file hash comparisons lack real-device validation |
| P0 before public V1 | **Network/security boundary QA**: two separate Wi-Fi networks, VPN routes, guest/client-isolated Wi-Fi and dangerous ICE candidate paths; confirm file payloads never flow through cloud signaling | No configured STUN/TURN and host-only selection; restricted host/prflx exception is approved; physical LAN routing **cannot be guaranteed by the browser**, so V1 must not market absolute LAN-only transfer |
| P0 before public V1 | **Real 3+ member and room lifecycle QA**: room creator departure, multi-uploader catalog, late joins, code reuse, 2-minute last-device offline window, rename and stale session takeover | Implemented/server or simulated UI tested; multi-device and sleep/refresh real-world regression coverage incomplete |
| P1 | **Mobile/browser matrix**: Android Chrome, Firefox mobile, iOS Safari; download/save behavior, background/screen-lock, Wi-Fi handover and memory pressure | PC Chrome ↔ mobile Firefox has partial field success; Android Chrome and iOS Safari are explicitly untested |
| P1 | **Privacy and abuse protection**: guessable 4-digit room codes, no local peer block/anti-spam controls, stronger public rate limiting and client/content privacy guidance | Joining by code without approval is intentional product behavior, but a short room code is not authentication; do not add mandatory approval or accounts without a product decision |
| P1 for public release | **Operations/security hardening**: CSP and proxy/origin audit, server load/abuse tests, WebSocket resilience, sleep/restart behavior, in-memory room loss and multi-instance policy | Render single-instance POC is live; hosted free/in-memory behavior is not production-grade |
| P2 optional UX | **QR room invite**, save-location selection where supported, clear browser permission/network failure messaging, durable Save-completion feedback | Not implemented or incomplete. Keep existing one-button create/join, room-wide share and per-device sequential receive behavior |
| Later / separate scope | Streaming for larger files and restart/resume support | Current max **32 MiB per file** and whole-file buffering are explicit POC limits; do not promise 100 MiB–1 GiB, folder sync, cloud relay or persistent file history |

**Recommended next milestone:** complete field-file/queue integrity checks, then multi-member/room life-cycle checks, then browser and network-safety matrix. Deferred ICE tuning stays visible in issue #6, but is not a prerequisite for implementing or testing independent functions. Public release readiness still requires a deliberate reliability decision.


## P0 — Restricted P2P mode (approved, 2026-11-18)

Real-device diagnostics confirmed an established WebRTC connection (`connection=connected`, `ice=connected`, `channel=open`) while the browser masked candidate addresses. The former strict private-IPv4 /24 rule incorrectly blocked this usable connection. The user explicitly approved **restricted B** on 2026-11-18.

Current rule: `RTCPeerConnection({iceServers: []})`; transmit only `host` ICE candidates in signalling, then validate the explicitly selected ICE candidate pair with `getStats()`:
- Preserve the existing `host/host` acceptance for different readable private IPv4 addresses in the same /24, or masked/mDNS host addresses.
- **User-approved narrow exception (2026-11-19):** allow a selected `local host / remote prflx` pair only when the pair is `succeeded` and `nominated`, ICE and RTCPeerConnection are connected, DataChannel is open, and the other endpoint has already sent its own route-verified `ready`. The existing path accepts a visible private IPv4 local host with hidden remote `prflx`, or two visible different private IPv4 addresses in the same /24.
- **User-approved compatibility option B (2026-11-19):** if the local host and remote `prflx` addresses are **both masked/mDNS/redacted**, allow only when the other endpoint's DataChannel `ready` additionally declares `hostHostVerified:true`. The sender only emits this declaration after locally checking a selected successful `host/host` pair, connected ICE/RTCPeerConnection and an open channel. A legacy `ready` without the declaration cannot enable the masked/masked exception. This declaration is a peer self-report, **not** cryptographic proof of same physical LAN.
- Reject `relay`/`srflx`, selected `local prflx`, visible public/unsupported addresses, visible IPv6, mismatched visible private /24 subnets, identical readable endpoints, incomplete selected-pair statistics, and a `host/prflx` pair without the above evidence.
- Recheck the selected candidate pair when sending and periodically during file chunks using the **same approved policy**; fail closed if the route becomes disallowed. No TURN, no file data via the public signalling server.

**Field evidence and approved decision (2026-11-19):** After a local-network permission adjustment, both peers reached `ice:connected` and `channel:open`. One side selected `host/host` with both candidate addresses masked/mDNS, passed its route check and sent legacy `ready`. The opposite side selected `host/prflx` with **both** candidate addresses hidden, received peer `ready`, but failed with `prflx-unverified`; the other side remained waiting for reciprocal `ready`. The user then explicitly chose **option B** to allow the fully masked pair only after a newer explicit reciprocal `host/host` confirmation. Code and simulated-controller/policy regression tests are in place; **real-device file transfer under option B remains unverified**.

**This is not an authoritative LAN-only policy.** Host P2P and peer-reflexive paths can traverse VPNs or routed networks, including paths outside the physical LAN. The other endpoint's `ready` message (including `hostHostVerified`) is a protocol self-report, not independent proof of its physical network route or identity. Absence of an application-configured STUN/TURN server does not prove the route; browser-hidden addresses prevent reliable classification. This is an explicit compatibility/security trade-off rather than a verified LAN guarantee.

Also, a room code is not authorization: room participants can view file metadata and initiate receiving any shared file. A four-digit code is easy to guess. Use non-sensitive test files until membership protection and real-device testing are completed.

## P0 — Real-device transfer and network-safety validation (ICE tuning deferred)

The user has since confirmed successful bidirectional file transfers between two real devices (2026-11-18). However, file sizes, saved-file hash comparison, multi-file queues and repeatability have not been established. Browser-side candidate stats are diagnostic hints, not proof of a physical LAN path. Test checksum-verified downloads on the newly deployed code, then test a VPN and two separate networks to measure connectivity and disclosure. Do not report strict LAN isolation as passed.

Official references: https://www.w3.org/TR/webrtc-stats/ and https://rtcweb-wg.github.io/mdns-ice-candidates/mmusic/draft-ietf-mmusic-mdns-ice-candidates.html

## P0 — Global room code and guessed IDs

The signalling service keeps active room codes in one global process. If users in different networks choose the same code, they see signalling presence and try to establish WebRTC. The path check should block file content unless candidate addresses pass. A 4-digit code has only 10,000 possibilities and is not a secret. Use rate limits, avoid persisting file names centrally, keep device block decisions local, and consider optional stronger room codes for sensitive use.

The home screen suggests a currently unused 4-digit code, **but does not reserve it**. By design, entering any code creates the room if absent and joins it if present. If someone else claims that four-digit code between suggestion and entry, the original user will join that room instead. Show members clearly and provide an easy regenerate option; a strict guarantee that suggested codes always create a new room would require reserving a code, a product behavior not selected for this version.

## P1 — Ephemeral room file shelf

The shared file catalog lives only in each uploader's browser memory and is replicated to verified room members over WebRTC; it is not persisted by the signalling service. Late joiners can discover files only while their uploader remains connected and a qualifying peer path is available. Refreshing, closing, or disconnecting the uploader removes its offers, including files others have not yet downloaded. This is not cloud storage or a persistent room drive.

## P1 — Integrity verification and stalls

The sender now transmits a lowercase SHA-256 digest inside the encrypted WebRTC DataChannel at the end of each file. The receiver calculates SHA-256 from received chunks and exposes a Save link only if the value matches. Missing, invalid or mismatched hashes fail the transfer; clients must both refresh to use this new protocol. This provides an end-to-end check against accidental corruption, **not** authentication of the uploader: a malicious room participant controls both their file and its digest. WebRTC already protects transmitted data in transit through DTLS.

Receiving files currently buffers a maximum of 32 MiB; SHA-256 calculation also requires whole-file access and can increase peak browser memory. The sender waits up to 20 seconds for file-start; once bytes begin flowing, the receiver uses a 30-second no-progress timeout instead of an unconditional 20-second cap. True streaming hashes, transfer resume and multi-device stress results are future work.

## P1 — Reliability and mobile downloads

The current receiver buffers the entire file (up to 32 MiB) before offering a browser download link. Long files/large transfers need streaming output with user-selected file handles where supported, or a robust fallback with explicit browser limitations. Do not claim a 1 GB mobile file is supported without live tests. A browser does not reliably continue transmitting when mobile OS backgrounds the tab.

## P1 — Rapid refresh and obsolete signaling (2026-11-18)

A client reported `目标设备已离线` while its local RTC object was still `answer-sent / ice:new`. The old implementation created a duplicate room member when a valid session token re-entered before the previous WebSocket had fully closed. An unexpected delayed offer could also recreate a peer that the room already marked offline.

The revised implementation supports authenticated WebSocket takeover, uses a new generation identifier for each peer session, rejects signaling addressed to an obsolete generation, ignores unknown/late peer signals, and prevents a replaced old socket from sending a false offline notice. Server integration and protocol tests pass; stable behavior across repeated real-world network changes is not yet proven. Both browsers should reload after deployment to use the generation-aware protocol.

## P1 — Automatic signalling recovery (2026-11-18)

The browser now reconnects on unexpected WebSocket loss, using the previous room code and session token with exponentially increasing retry delays capped at 15 seconds. A successful room welcome resets the backoff and rebuilds the WebRTC connections. Existing uploader-local File objects remain staged and are resynchronized to verified peers; interrupted inbound jobs and queued downloads fail safely instead of assuming byte-stream resumption. An explicit Leave cancels timers. The aiohttp WebSocket server already has a 25-second ping heartbeat, and no extra app-layer ping was introduced.

Node-based browser controller tests cover backoff, restoration of the room identity and local file objects, interrupted queued jobs, rejection of invalid initial entry, and Leave cancellation. These are stubbed tests, not evidence that all mobile/sleep/wake or Wi-Fi handover conditions are stable. ICE retry while signalling remains healthy is a separate remaining problem.

## P1 — Bounded WebRTC negotiation recovery (2026-11-18)

A real-device diagnostic showed `signal=connected`, `stage=answer-sent`, `ice=new`, `channel=none` and zero signalling errors after 46 seconds. The previous 12-second timer only changed the displayed error; it did not repair the peer connection. This release retries with a fresh `RTCPeerConnection` (two normal ICE attempts, then two attempts with offerer/answerer reversed), lets the responder send bounded retry requests to the offerer, and marks each offer/answer/host candidate with an attempt number to prevent old ICE from entering a new connection. The role reversal happens only if the original offerer exhausts its two normal attempts without a healthy open channel; a failure on the first reversed attempt gets one last reversed-direction retry. This prioritizes the direction observed to work on the Chrome/Firefox mobile field test without increasing the total four-attempt limit. This is a compatibility fallback, not proof of mDNS or LAN reachability repair. When ICE fails or disconnects, a shorter recovery timer is set. Already open file channels are not needlessly replaced. No STUN/TURN was introduced and the host-only route checks still apply.

Python signalling tests and mock browser-controller tests cover the attempt message, retry bounds, stale candidates, old PC cleanup, and open-channel preservation. These tests do not prove that multiple attempts will overcome network isolation, mDNS or UDP reachability problems. Both devices must refresh after deployment. Record both peers' new `attempt`, `signalingState`, `iceGathering`, local/remote description flags, `ice`, and `channel` if repeated field tests fail.

## P1 — Scope still pending

- QR invite / mobile scan flow
- Optional custom save-location UI
- Durable file save completion acknowledgement
- Peer block list and anti-spam UX
- Real-network effectiveness of bounded ICE reoffers, plus richer retry/resume for interrupted download jobs
- Better error UX: browser permissions, blocked Wi-Fi client isolation, wrong network
- Live end-to-end tests with two distinct devices and public HTTPS signalling

## Official API references

- MDN: https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidatePairStats
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidateStats
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmountLowThreshold
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API
