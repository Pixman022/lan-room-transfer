# Technical risks and gaps (2026-11-18)

## P0 — Strong LAN-only assertion remains unverified

`RTCPeerConnection` can establish a direct peer connection without a TURN relay, but P2P does not imply physical LAN. Two peers on a VPN or using globally routable IPv6 can appear to be directly connected even though traffic may traverse a public network. Browsers can mask host addresses using mDNS; sometimes candidate stats do not reveal enough information for a conservative check.

Current fail-closed test strategy: `iceServers=[]`, transmit only host candidates, inspect the selected ICE candidate pair using `getStats()`, require both readable IPv4 RFC1918 host candidates in the same /24 and reject same-IP candidates. Recheck periodically during transfer. This is intentionally narrower than "same local network" and is not an authoritative routing proof. The prototype must not be advertised as guaranteeing LAN-only transmission.

**Decision gate**: If field testing confirms browser-only route information is insufficient for a hard LAN-only guarantee, choose one of the following explicitly before production:
1. Redefine the promise to "direct P2P, no content upload to our server" (this is a **product requirement change**, requiring user approval), or
2. Use an additional trusted network-local component or a platform API where applicable (this changes the zero-install/zero-deploy promise and requires product approval), or
3. Keep strict fail-closed behavior and accept limited browser/network support, provided false-positive network-routing risks are evaluated.

## P0 — Global room code and guessed IDs

The signalling service keeps active room codes in one global process. If users in different networks choose the same code, they see signalling presence and try to establish WebRTC. The path check should block file content unless candidate addresses pass. A 4-digit code has only 10,000 possibilities and is not a secret. Use rate limits, avoid persisting file names centrally, keep device block decisions local, and consider optional stronger room codes for sensitive use.

The home screen suggests a currently unused 4-digit code, **but does not reserve it**. By design, entering any code creates the room if absent and joins it if present. If someone else claims that four-digit code between suggestion and entry, the original user will join that room instead. Show members clearly and provide an easy regenerate option; a strict guarantee that suggested codes always create a new room would require reserving a code, a product behavior not selected for this version.

## P1 — Reliability and mobile downloads

The current receiver buffers the entire file (up to 32 MiB) before offering a browser download link. Long files/large transfers need streaming output with user-selected file handles where supported, or a robust fallback with explicit browser limitations. Do not claim a 1 GB mobile file is supported without live tests. A browser does not reliably continue transmitting when mobile OS backgrounds the tab.

## P1 — Scope still pending

- QR invite / mobile scan flow
- Optional custom save-location UI
- Durable file save completion acknowledgement
- Peer block list and anti-spam UX
- Clean handling of rapid reconnect/ICE restarts and queue recovery
- Better error UX: browser permissions, blocked Wi-Fi client isolation, wrong network
- Live end-to-end tests with two distinct devices and public HTTPS signalling

## Official API references

- MDN: https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidatePairStats
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidateStats
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmountLowThreshold
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API
