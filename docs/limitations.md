# Technical risks and gaps (2026-11-18)

## Active project backlog (reviewed 2026-11-19)

The shipped site and repository are a **research POC**, not a production-ready or physically LAN-guaranteed file transfer product. Distinguish implemented-and-tested-in-unit-simulation from verified-on-real-devices. The user's current decision is to **defer further Chrome desktop ↔ Firefox mobile ICE reliability tuning**. Do not change the existing 2+2 negotiation policy as part of unrelated work.

### Deferred: cross-browser ICE connection reliability

**Tracked:** [GitHub issue #6](https://github.com/Pixman022/lan-room-transfer/issues/6) · **Status: deferred for later optimization**. On 2026-11-19 the user completed five single-click PC Chrome-created room → mobile Firefox join trials: automatic P2P-ready **4/5**, successful setup times **15, 35, 15, 34 s** (mean **24.75 s**, median **24.5 s**), **three** confirmed file receipts, a fourth unconfirmed, and one failed/manual-rejoin round. The failed round had no two-sided snapshot; do not assume mDNS, ICE candidate-pair resolution or timers are the root cause. Redacted per-attempt diagnostics are deployed. Future acceptance and investigation live in issue #6; no current-sprint modification is planned.

### Next work (excluding deferred ICE tuning)

| Priority | Remaining work | Actual baseline and acceptance |
| --- | --- | --- |
| P0 before public V1 | **File/receiver end-to-end QA**: same-file saved SHA-256 comparison on two real devices, both directions, Receive All sequential queue, cancellation/failed retry, source withdrawal, unexpected disconnect, 1 MiB / 33 MiB and larger-file memory checks | SHA-256 and queue logic exist with controller/unit/mock UI coverage. **One real A→B 5 MiB received file was independently hashed and matched the reference after B rejoined** (2026-11-20). A subsequent three-device synchronized run completed all three transfers with in-app SHA-256 and approximately 1.10 s of trigger-relative byte-window overlap. Full-run external saved-file hashes remain unverified. C separately confirmed real-device sequential Receive All and Save for 5 MiB / 64 KiB / 0-byte files; independent hashes of that batch and large-file reliability also remain unverified |
| P0 before public V1 | **Network/security boundary QA**: two separate Wi-Fi networks, VPN routes, guest/client-isolated Wi-Fi and dangerous ICE candidate paths; confirm file payloads never flow through cloud signaling | No configured STUN/TURN and host-only selection; restricted host/prflx exception is approved; physical LAN routing **cannot be guaranteed by the browser**, so V1 must not market absolute LAN-only transfer |
| P0 before public V1 | **Real 3+ member and room lifecycle QA**: creator departure, multi-uploader catalog, late joins, immediately closing an empty room, same-code reuse, rename and stale session takeover | **2026-11-20:** 3-device field tests passed M01 entry, M02 late join, M04 cancel/retry, M05 withdrawal and M06 creator departure. M03 missing B→A/C shared-file catalog was fixed by [PR #13](https://github.com/Pixman022/lan-room-transfer/pull/13) and confirmed in the field ([issue #11](https://github.com/Pixman022/lan-room-transfer/issues/11)). The previous 2-minute empty-room retention was removed by the user's follow-up decision: the room now closes as soon as the last online member disconnects. **Updated three-device WebSocket integration tests verify immediate teardown, fresh same-code room/new member identity, and continued communication while another member stays online**; physical retest pending. Simulated A→B/C and B→A file transfers with real WebCrypto pass, but physical simultaneous payload/hashes remain pending. The diagnostic `roomEntry` remains created/joined/resumed without exposing credentials. [ICE Issue #6](https://github.com/Pixman022/lan-room-transfer/issues/6) remains deferred |
| P1 | **Mobile/browser matrix**: Android Chrome, Firefox mobile, iOS Safari; download/save behavior, background/screen-lock, Wi-Fi handover and memory pressure | PC Chrome ↔ mobile Firefox has partial field success; Android Chrome and iOS Safari are explicitly untested |
| P1 | **Privacy and abuse protection**: guessable 4-digit room codes, no local peer block/anti-spam controls, stronger public rate limiting and client/content privacy guidance | Joining by code without approval is intentional product behavior, but a short room code is not authentication; do not add mandatory approval or accounts without a product decision |
| P1 for public release | **Operations/security hardening**: CSP and proxy/origin audit, server load/abuse tests, WebSocket resilience, sleep/restart behavior, in-memory room loss and multi-instance policy | Render single-instance POC is live; hosted free/in-memory behavior is not production-grade |
| P2 optional UX | **QR room invite**, save-location selection where supported, clear browser permission/network failure messaging, durable Save-completion feedback | Not implemented or incomplete. Keep existing one-button create/join, room-wide share and per-device sequential receive behavior |
| Later / separate scope | Streaming for robust larger-file transfers and restart/resume support | **Fixed 32 MiB application cap removed for experiments**, but entire-file buffering and whole-file WebCrypto hashing remain. Browser/OS memory and transfer stalls are practical limits. Do not promise stable 100 MiB–1 GiB, folder sync, cloud relay or persistent history without actual tests |

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

## P1 — Mid-transfer selected host/prflx proof refresh (2026-11-19)

**Field observation:** In a three-file Chrome PC / Firefox mobile test, a 5.9 MB file was saved while 17.8 MB and 29.8 MB files failed mid-transfer with `prflx-unverified` even after retry. These are **real file-transfer path-verification failures**, not evidence that the WebSocket room or DataChannel itself failed. Which precise prerequisite failed (pair nomination, browser stats, current remote host/host proof, or address visibility) is not known without both devices' normal redacted diagnostics.

The sender pauses outgoing file bytes whenever a periodic path recheck is denied. A compatibility fix recognizes the **currently selected and succeeded** ICE candidate pair from standard `transport.selectedCandidatePairId` or Firefox's `selected:true` when the optional `nominated` field is absent; an **explicit `nominated:false` still fails**. If a safe-looking selected host/prflx pair lacks the reciprocal host/host proof from the original `ready` handshake, the sender asks the peer **over P2P DataChannel** to re-evaluate its *current* selected host/host pair. The peer replies with a true proof **only** if the existing policy validates that current host/host pair. After at most two paused 250 ms rechecks, the sender proceeds only on a freshly `allowed` verdict. An absent/negative proof or an explicitly unsafe path always stops the file. No TURN, non-host relay, cloud file transport, or change to the 2+2 ICE policy was introduced.

**Remaining uncertainty:** A peer's proof is still its own declaration, not cryptographic evidence of the same physical LAN. A persistent `prflx-unverified` can be correct and must not be blindly bypassed. Normal diagnostics now include privacy-reduced `lastPathRecheckEvidence` (selected pair state, nominated yes/no/missing, transport-selected and Firefox selected flags, remote ready and remote host proof booleans, candidate *address kinds only*, no IPs), plus route-proof message counters. **2026-11-19 field retest:** after PR #10 (`e2b690fb`) was deployed, the user confirmed that the previously failing three-file receive scenario succeeded on the PC Chrome / mobile Firefox pair. This is one successful real-device acceptance run; it does not prove sustained reliability, physical-LAN-only routing, or independent comparison of saved-file SHA-256 values. If `prflx-unverified` recurs, collect both devices' **ordinary** diagnostics. See `FILE-PRFLX-02` in `docs/test-matrix.md`.

## P0 — Real-device transfer and network-safety validation (ICE tuning deferred)

The user has since confirmed successful bidirectional file transfers between two real devices (2026-11-18). One 5 MiB saved-file SHA-256 was subsequently independently confirmed on A→B after a fresh B rejoin (2026-11-20), and a later synchronized three-device run completed with all three app-side SHA-256 checks and approximately 1.10 s of trigger-relative receive-window overlap. Independent saved-file comparisons from the latest run remain outstanding. C separately confirmed three-file sequential Receive All and empty-file Save; independent saved hashes for that batch and repeated-run reliability remain unverified. Browser-side candidate stats are diagnostic hints, not proof of a physical LAN path. Test checksum-verified downloads on the newly deployed code, then test a VPN and two separate networks to measure connectivity and disclosure. Do not report strict LAN isolation as passed.

Official references: https://www.w3.org/TR/webrtc-stats/ and https://rtcweb-wg.github.io/mdns-ice-candidates/mmusic/draft-ietf-mmusic-mdns-ice-candidates.html

## P0 — Global room code and guessed IDs

The signalling service keeps active room codes in one global process. If users in different networks choose the same code, they see signalling presence and try to establish WebRTC. The path check should block file content unless candidate addresses pass. A 4-digit code has only 10,000 possibilities and is not a secret. Use rate limits, avoid persisting file names centrally, keep device block decisions local, and consider optional stronger room codes for sensitive use.

The home screen suggests a currently unused 4-digit code, **but does not reserve it**. By design, entering any code creates the room if absent and joins it if present. If someone else claims that four-digit code between suggestion and entry, the original user will join that room instead. Show members clearly and provide an easy regenerate option; a strict guarantee that suggested codes always create a new room would require reserving a code, a product behavior not selected for this version.

## P1 — Ephemeral room file shelf

The shared file catalog lives only in each uploader's browser memory and is replicated to verified room members over WebRTC; it is not persisted by the signalling service. Late joiners can discover files only while their uploader remains connected and a qualifying peer path is available. Refreshing, closing, or disconnecting the uploader removes its offers, including files others have not yet downloaded. This is not cloud storage or a persistent room drive.

## P1 — Integrity verification and stalls

The sender now transmits a lowercase SHA-256 digest inside the encrypted WebRTC DataChannel at the end of each file. The receiver calculates SHA-256 from received chunks and exposes a Save link only if the value matches. Missing, invalid or mismatched hashes fail the transfer; clients must both refresh to use this new protocol. This provides an end-to-end check against accidental corruption, **not** authentication of the uploader: a malicious room participant controls both their file and its digest. WebRTC already protects transmitted data in transit through DTLS.

Receiving files currently buffers **the complete file** without a fixed application-side limit. Browser WebCrypto SHA-256 requires a whole-file ArrayBuffer at both endpoints, increasing peak memory and causing large-file failure on constrained devices. The sender waits up to 20 seconds for file-start; once bytes begin flowing, the receiver uses a 30-second no-progress timeout instead of an unconditional 20-second cap. True streaming hashes, transfer resume and multi-device stress results are future work.

## P1 — Reliability and mobile downloads

The current receiver buffers the entire file before offering a browser download link. The former 32 MiB cap was removed for experimental larger-file trials, but this does not provide streaming or memory-safe large-file support. Long files/large transfers need streaming output with user-selected file handles where supported, or a robust fallback with explicit browser limitations. Do not claim a 1 GB mobile file is supported without live tests. A browser does not reliably continue transmitting when mobile OS backgrounds the tab.

## P1 — Rapid refresh and obsolete signaling (2026-11-18)

A client reported `目标设备已离线` while its local RTC object was still `answer-sent / ice:new`. The old implementation created a duplicate room member when a valid session token re-entered before the previous WebSocket had fully closed. An unexpected delayed offer could also recreate a peer that the room already marked offline.

The revised implementation supports authenticated WebSocket takeover, uses a new generation identifier for each peer session, rejects signaling addressed to an obsolete generation, ignores unknown/late peer signals, and prevents a replaced old socket from sending a false offline notice. Server integration and protocol tests pass; stable behavior across repeated real-world network changes is not yet proven. Both browsers should reload after deployment to use the generation-aware protocol.

## P1 — Automatic signalling recovery (2026-11-18)

The browser now reconnects on unexpected WebSocket loss, using the previous room code and session token with exponentially increasing retry delays capped at 15 seconds. A successful room welcome resets the backoff and rebuilds the WebRTC connections. Existing uploader-local File objects remain staged and are resynchronized to verified peers; interrupted inbound jobs and queued downloads fail safely instead of assuming byte-stream resumption. An explicit Leave cancels timers. The aiohttp WebSocket server retains a 25-second native ping heartbeat, but browser JavaScript cannot observe its Pong replies. For an otherwise idle room, the joined client now sends a **signal-only** keepalive every 20 seconds and expects the server's matching acknowledgement by the next tick. A still-open but silent socket is detached and moved through the existing reconnect flow, retaining local File objects; the server continues to decide when an old empty room is actually released. Ordinary diagnostics expose only counters and an enum (`signalKeepalive`: sent, acksReceived, timeouts, pending, disconnects, reconnectsScheduled, lastDisconnect), with no file names, addresses, room code or session token. Background-tab throttling, transient outages and stale TCP/server detection can delay or alter observed `created` versus `resumed`; one fast network toggle is not conclusive proof of last-member room destruction. This recovery is separate from deferred ICE Issue #6.

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
