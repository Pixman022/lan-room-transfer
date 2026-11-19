# Full browser connection debug

LAN Room enables **verbose, unredacted console tracing** only when the current tab's URL contains `?debug=1`.

- Debug URL: `https://lan-room-transfer.onrender.com/?debug=1`
- Normal URL: `https://lan-room-transfer.onrender.com/` (no full trace)
- Refresh **both** the PC browser and the mobile browser using the debug URL before each attempt.
- In `?debug=1`, click the existing **诊断 → 复制诊断** button to copy complete JSON evidence from that device, without needing a mobile DevTools console. If clipboard permissions block copying, the page attempts to download `lan-room-ice-debug.json` locally. Normal mode still copies a small, redacted status report.
- PC: Chrome/Edge **F12 → Console**, enable **Preserve log**; optionally save the output.
- Android Chrome: use remote DevTools from a PC (`chrome://inspect/#devices`) to view the phone's console.
- iPhone Safari: use Safari Web Inspector from a Mac to inspect the phone.

Trace entries have a `[LAN Room debug +…ms]` prefix and contain these full, **unredacted** values when the browser exposes them:

- Exact room code, device name/ID, session token, session generation and peer IDs.
- Raw incoming and outgoing WebSocket JSON messages, including complete SDP offers, answers, ICE candidates and retry attempts.
- ICE candidate and gathering events; connection/ICE/signaling states and error events.
- Full `RTCPeerConnection.getStats()` reports on transport changes, connection timeouts and DataChannel opening, including available candidate addresses/ports.
- The opt-in copied JSON contains `iceSummary` for each device: browser-exposed `localCandidates`, `remoteCandidates`, `candidatePairs` and `transports`, plus all available raw stats. Candidate-pair check counters (`requestsSent`, `requestsReceived`, `responsesReceived`) distinguish whether connectivity checks ran. It also tracks how many received candidates were accepted or rejected by `addIceCandidate()`.
- The copied `events` array retains at most the 300 latest detailed traces, including complete SDP, signaling messages and ICE candidate lines across retry attempts.
- DataChannel control messages and original shared file names and metadata.
- Once ICE and DataChannel are connected, the app still requires two-sided route verification: each side sends a `{"kind":"ready"}` control message only after validating its selected host/host pair, or an eligible `local host / remote prflx` pair **after receiving the other side's `ready`**. In full diagnostics inspect `detailedPeers[].handshake` (`localPathVerified`, `localReadySent`, `remoteReadyReceived`, `transferReady`), `webrtc.route.verdict`, `datachannel.send.ready`, `datachannel.ready.received`, and `datachannel.ready.timeout`. If the PC has `localReadySent=true` and `remoteReadyReceived=false`, collect the **phone's** diagnostic report. A phone-side `localCandidateType=host`, `remoteCandidateType=prflx` now takes the tightly scoped exception if its ICE/DTLS/DataChannel are connected, the selected pair is nominated/succeeded, PC already signaled `ready`, and visible addresses satisfy the private-subnet rules. `route.code` will show `masked-host-prflx-p2p` or `private-ipv4-host-prflx-pair` if allowed. This is not proof of physical LAN isolation.
- Timing of socket close/reconnect, peer replacement and ICE retry attempts.

**New ICE classification:** Each `detailedPeers[].iceDiagnosis` in full-debug JSON contains an interpretation code, observed `.local` host candidate counts, reported ICE candidate-pair counts and connectivity check counters. `mdns-resolution-or-candidate-pair-suspected` means that an mDNS candidate was accepted by the API but the browser did not expose a resolved remote candidate or a connection pair. It is a **suspicion**, not proof that mDNS resolution failed. `checks-without-response` only appears when the browser actually exposes response counters and recorded outgoing checks without replies. Normal (non-debug) diagnostics are unchanged.

**Controlled compatibility test:** Keep PC Chrome and the same Wi-Fi/router; first try the phone with Chrome, then its previous Firefox browser. If only Firefox fails, capture full-debug JSON from *both* browser/device pairs. If both fail, prioritize mDNS/multicast client isolation, guest networks, VPN and PC firewall/network profile checks. Do not add STUN/TURN or disable browser privacy protections as a hidden fallback.

**Browser limitation:** WebRTC stats are browser-dependent. A missing `candidate-pair` or counter does not prove there was no connectivity check. mDNS address obfuscation or IP redaction can prevent JavaScript, even in full debug mode, from seeing the real LAN IP. The logs contain everything available through WebRTC APIs, but cannot bypass browser privacy enforcement.

**Security:** Full debug prints room credentials, WebRTC ICE credentials, IP addresses and filenames to the local browser console. It does not send debug logs to LAN Room's cloud service. Do not post a raw console export to public issue trackers or share it with strangers. A debug URL does **not** include credentials in its query string, and reopening the ordinary URL disables tracing.

## Reproduce the asymmetry

1. On PC, enter an unused room and keep the Console open.
2. On mobile, open the same room with `?debug=1`, preserve its Console and check first connection.
3. Exit both; let mobile enter first, then PC. Repeat the second PC join.
4. Compare `websocket.receive`, `peer.created`, `webrtc.createOffer.done`, `webrtc.setRemoteDescription.*`, `webrtc.icecandidate`, `webrtc.iceconnectionstatechange`, `peer.connect.timeout.*`, and `datachannel.open` in both browser consoles.

The receiving/sending flow, room rules and restricted host-only P2P policy are unchanged. Full trace is diagnostic only and does not demonstrate that an IPv4 address is physically on the same LAN.
