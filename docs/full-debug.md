# Full browser connection debug

LAN Room enables **verbose, unredacted console tracing** only when the current tab's URL contains `?debug=1`.

- Debug URL: `https://lan-room-transfer.onrender.com/?debug=1`
- Normal URL: `https://lan-room-transfer.onrender.com/` (no full trace)
- Refresh **both** the PC browser and the mobile browser using the debug URL before each attempt.
- PC: Chrome/Edge **F12 → Console**, enable **Preserve log**; optionally save the output.
- Android Chrome: use remote DevTools from a PC (`chrome://inspect/#devices`) to view the phone's console.
- iPhone Safari: use Safari Web Inspector from a Mac to inspect the phone.

Trace entries have a `[LAN Room debug +…ms]` prefix and contain these full, **unredacted** values when the browser exposes them:

- Exact room code, device name/ID, session token, session generation and peer IDs.
- Raw incoming and outgoing WebSocket JSON messages, including complete SDP offers, answers, ICE candidates and retry attempts.
- ICE candidate and gathering events; connection/ICE/signaling states and error events.
- Full `RTCPeerConnection.getStats()` reports on transport changes, connection timeouts and DataChannel opening, including available candidate addresses/ports.
- DataChannel control messages and original shared file names and metadata.
- Timing of socket close/reconnect, peer replacement and ICE retry attempts.

**Browser limitation:** mDNS address obfuscation or IP redaction can prevent JavaScript, even in full debug mode, from seeing the real LAN IP. The logs contain everything available through WebRTC APIs, but cannot bypass browser privacy enforcement.

**Security:** Full debug prints room credentials, WebRTC ICE credentials, IP addresses and filenames to the local browser console. It does not send debug logs to LAN Room's cloud service. Do not post a raw console export to public issue trackers or share it with strangers. A debug URL does **not** include credentials in its query string, and reopening the ordinary URL disables tracing.

## Reproduce the asymmetry

1. On PC, enter an unused room and keep the Console open.
2. On mobile, open the same room with `?debug=1`, preserve its Console and check first connection.
3. Exit both; let mobile enter first, then PC. Repeat the second PC join.
4. Compare `websocket.receive`, `peer.created`, `webrtc.createOffer.done`, `webrtc.setRemoteDescription.*`, `webrtc.icecandidate`, `webrtc.iceconnectionstatechange`, `peer.connect.timeout.*`, and `datachannel.open` in both browser consoles.

The receiving/sending flow, room rules and restricted host-only P2P policy are unchanged. Full trace is diagnostic only and does not demonstrate that an IPv4 address is physically on the same LAN.
