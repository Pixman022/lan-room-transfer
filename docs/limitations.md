# Technical risks and gaps (2026-11-18)

## P0 — Restricted P2P mode (approved, 2026-11-18)

Real-device diagnostics confirmed an established WebRTC connection (`connection=connected`, `ice=connected`, `channel=open`) while the browser masked candidate addresses. The former strict private-IPv4 /24 rule incorrectly blocked this usable connection. The user explicitly approved **restricted B** on 2026-11-18.

Current rule: `RTCPeerConnection({iceServers: []})`, transmit only `host` ICE candidates in signalling, require an explicitly selected `host`/`host` pair in `getStats()`, then:
- Allow private IPv4 peers if two readable endpoints are different and in the same /24.
- Allow a selected host pair when one/both addresses are mDNS-obfuscated, absent or redacted.
- Reject any selected `relay`/`srflx` pair, visible public/unsupported addresses, visible IPv6, distinct visible private /24 subnets, identical readable endpoints, and missing selected-pair/type statistics.
- Recheck the selected candidate pair periodically while sending file chunks. No TURN and no file data via the public signalling server.

**This is not an authoritative LAN-only policy.** Host-only P2P can still traverse a VPN or routed network, including paths outside the physical LAN. Absence of an application-configured STUN/TURN server doesn't prove the network route; browser-hidden addresses prevent reliable classification. This is a deliberate compatibility/security trade-off rather than a verified LAN guarantee.

Also, a room code is not authorization: room participants can view file metadata and initiate receiving any shared file. A four-digit code is easy to guess. Use non-sensitive test files until membership protection and real-device testing are completed.

## P0 — Real-device connection reliability

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

## P1 — Scope still pending

- QR invite / mobile scan flow
- Optional custom save-location UI
- Durable file save completion acknowledgement
- Peer block list and anti-spam UX
- ICE failure/restart while signalling remains connected, plus richer retry/resume for interrupted download jobs
- Better error UX: browser permissions, blocked Wi-Fi client isolation, wrong network
- Live end-to-end tests with two distinct devices and public HTTPS signalling

## Official API references

- MDN: https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidatePairStats
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidateStats
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmountLowThreshold
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API
