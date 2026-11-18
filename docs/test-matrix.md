# POC field test matrix

Status (2026-11-18): **User reports successful bidirectional file transfer between real devices after restricted P2P mode was deployed.** This confirms the basic send/receive path was exercised by the user, beyond the previous room-entry-only result. File sizes, saved-file SHA-256 comparisons, repeated-run reliability, device/browser versions, and cross-network security have **not** been independently verified. Earlier "未通过/未测试" responses were ambiguous and are superseded only for the basic transfer scenario.

**Connection stability follow-up (2026-11-18):** User reported that establishing a peer connection sometimes takes unusually long and behaves inconsistently. This is an observation, not yet a measured failure rate. Code fixes now serialize incoming SDP/ICE operations, send local SDP before buffered candidates, forward ICE end-of-candidates, and show an explicit status after 12 seconds while permitting late recovery. Do not equate this to verified performance improvement until separate devices repeat the test. For each retry, record `stage`, `elapsedSeconds`, `candidatesSent`, `candidatesReceived`, `ice`, `channel`, and `reason` from the privacy-reduced diagnostics on both devices. Browser automation here could only test mocked peer sequencing, not a genuine routed LAN path.

**Follow-up after user diagnostics (2026-11-18):** An actual client reported `signalErrors=1` with `目标设备已离线`, while a peer remained at `answer-sent / ice:new`. The root cause candidates were live-session refresh creating duplicate member IDs and stale signals recreating peers after a disconnect. The fix assigns each WebSocket incarnation a generation, uses authenticated session takeover, and prevents stale ICE/SDP/offline messages from mutating the new peer. The latest Python server integration tests passed. **Repeated field reliability is still untested**; test 10 quick refresh/rejoin cycles with two real devices before closing this item. After a new deployment both open pages must be refreshed because signaling payloads now include generation IDs.

To collect follow-up evidence, open **诊断** next to the online device count and use **复制诊断** separately on each device. The copied report excludes room code, member names, file names, and network IP addresses. Record whether the status says 房间已连接, 直连未就绪 or 文件直连就绪; also record whether the uploader's file shows 等待设备直连 or 可供 N 台设备接收. Do not infer that "房间已连接" means the file path is ready. The approved restricted host-only P2P policy is active; it is not a physical LAN guarantee.

| Case | Setup | Expected outcome | Status |
|---|---|---|---|
| P2P-01 | Two real devices on same Wi-Fi/router with a direct host pair | Join same room, accept masked host addresses, share and download a 1 MB test file; verify saved hash | **Partial: user-reported bidirectional transfer successful**; exact file size, download/hash and network characteristics still to verify |
| P2P-02 | Two different Wi-Fi networks with internet | Verify no cloud relay; host-only peer connectivity may succeed or fail. Record actual path and warn that physical LAN isolation is not guaranteed | Not run |
| LAN-03 | Two devices on guest Wi-Fi with AP/client isolation | Cannot establish direct connection; clear error | Not run |
| LAN-04 | Two devices on a VPN exposing similar private IP ranges | Observe and assess whether route heuristic can give false positives | Not run |
| P2P-05 | Selected pair exposes global IPv6, relay or reflexive candidates | Reject transfer; no cloud relay or file content | Policy unit tested; field pending |
| P2P-06 | Selected host pair contains a browser-masked/mDNS address | Allow encrypted P2P transfer if the other safety checks pass; do not claim LAN-only routing | Policy unit tested; real devices pending |
| RECOVER-01 | Joined browser loses WebSocket unexpectedly, service later returns | Automatically retry the original room with session token (1, 2, 4, 8, capped 15 seconds), recover identity and create fresh peer channels | Node controller regression passed; two-device field test pending |
| RECOVER-02 | Uploader stages files, then loses WebSocket briefly | Preserve own File objects and reannounce catalog after reconnect; clear stale peer lists, do not resume interrupted byte streams without fresh request | Node controller regression passed; two-device field test pending |
| RECOVER-03 | User intentionally leaves a room while retry timer is scheduled | Cancel retry timer and clear room/offers; do not re-enter on the next timer | Node controller regression passed; field test pending |
| REJOIN-01 | Device B refreshes before its old WebSocket has fully closed | Authenticated session replaces old socket; same member ID with a new signaling generation; other devices see one offline/online replacement pair | Server integration test passed; live repeated refresh pending |
| REJOIN-02 | Delayed offer/answer/ICE from a previous generation | Server declines old-generation targets; clients ignore unknown/stale source generations; stale socket close must not remove the resumed peer | Server integration and room unit tests passed; offline browser regression authored; real devices pending |
| REJOIN-03 | Send signaling to a truly offline or obsolete target | Receive a targeted `peer-unavailable` response and clear the stale peer instead of leaving an indefinite pending connection | Server integration test passed; real devices pending |
| ROOM-01 | Three clients join with the same custom code | No approval, online member updates | API tested, browser pending |
| ROOM-00 | First client enters unused code, second enters same code | Single Enter Room button; first automatically creates, second joins the same room | API tested; browser pending |
| ROOM-00B | Landing page opens for a new client | English Color + Animal random device name and unused four-digit code are shown; both are editable, one entry action | Name/code unit + offline browser UI tests passed; live pending |
| ROOM-00C | Concurrent clients enter identical unused code | Exactly one room is created, both clients become members | API tested; browser pending |
| ROOM-02 | Room creator leaves, remaining clients stay | Room remains accessible | API behavior covered, browser pending |
| ROOM-03 | All leave, one returns within 2 min | Resumes room without code reclaim | API test covers resume, field pending |
| ROOM-04 | All leave longer than 2 min | Code reusable as fresh room | Unit tested, field pending |
| NAME-01 | Browser first visit, then reload and rejoin | Color + Animal generated name persists; old generated Chinese label+digits migrates | Unit tested; offline UI passed, live pending |
| NAME-02 | Rename while in a room | Other online peers see the new name; member ID and room remain unchanged | Signalling API tested, offline browser UI passed; live pending |
| UX-01 | Enter room alone and choose a file | File is staged in the room with no recipient selection, even before another device joins | Offline browser UI harness passed; LAN field test pending |
| UX-02 | Two verified devices join after first file is shared | Both receive the current file catalog through their own peer channels | Offline browser UI harness passed; field test pending |
| UX-03 | Upload another file with two verified devices connected | Both see the new file metadata, not its bytes; unverified peers receive no catalog | Offline desktop/mobile UI harness passed; LAN field test pending |
| UX-04 | Uploading device withdraws file | File disappears from other room devices and is unavailable to new joiners | Offline browser UI harness passed; LAN field test pending |
| UX-05 | Uploading device goes offline | Its shared files disappear from the room; already downloaded files remain available locally | Offline browser UI harness passed; LAN field test pending |
| FILE-01 | Receiver clicks one file's Receive | Only that file is transferred | **Basic transfer user-reported successful in both directions**; per-file control and checksum not separately verified |
| HASH-01 | Receive a small file on updated clients | Sender sends SHA-256 on P2P file-end; receiver verifies exact bytes before exposing Save link | SHA-256 helper unit tests pass; real-device UI pending |
| HASH-02 | Corrupted bytes, missing/malformed hash | Receiver rejects data, offers retry, never exposes Save link for failed content | Unit tests cover checksum mismatch and bad hashes; end-to-end fault injection pending |
| FILE-02 | Receiver clicks Receive All | Remaining files transferred sequentially | Browser pending |
| FILE-03 | Cancel, disconnect, retry | Clear states; no data mixed between jobs | Browser pending |
| FILE-05 | File transfer runs longer than 20 seconds but makes progress | Do not time out during normal progress; fail if no progress for 30 seconds | Code updated; real-device slow-link test pending |
| FILE-04 | 10 MB, then 100 MB, then 1 GB | Track time, memory and save success; larger files are **future** goals | 10 MB possible within cap, live test pending; others unsupported |
| MOBILE-01 | Android Chrome | Join, share files directly, receive, save | Not run |
| MOBILE-02 | iOS Safari | Join, share files directly, receive, save | Not run |

For every test record: browser/version, operating system, selected ICE candidate types/addresses (redacted), route verdict, bytes actually sent, SHA-256 verification and saved-file comparison, user-visible error, and pass/fail. Do not collect filenames or file bytes in public service logs.

Offline UI interaction harness (`python tests/offline_room_ui.py`) uses mocked peer connections, not real signalling or file bytes. It checks room entry, English names and animal avatars, sharing before any peers arrive, room-wide file announcements, late-join synchronization, withdrawal, single/receive-all controls, sequential queue, inline rename, and mobile/desktop overflow; screenshots in `docs/*-static.png` reflect this test fixture only.
