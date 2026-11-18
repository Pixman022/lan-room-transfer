# POC field test matrix

Status (2026-11-18): **User reports successful bidirectional file transfer between real devices after restricted P2P mode was deployed.** This confirms the basic send/receive path was exercised by the user, beyond the previous room-entry-only result. File sizes, saved-file SHA-256 comparisons, repeated-run reliability, device/browser versions, and cross-network security have **not** been independently verified. Earlier "未通过/未测试" responses were ambiguous and are superseded only for the basic transfer scenario.

**Connection stability follow-up (2026-11-18):** User reported that establishing a peer connection sometimes takes unusually long and behaves inconsistently. This is an observation, not yet a measured failure rate. Code fixes now serialize incoming SDP/ICE operations, send local SDP before buffered candidates, forward ICE end-of-candidates, and show an explicit status after 12 seconds while permitting late recovery. Do not equate this to verified performance improvement until separate devices repeat the test. For each retry, record `stage`, `elapsedSeconds`, `candidatesSent`, `candidatesReceived`, `ice`, `channel`, and `reason` from the privacy-reduced diagnostics on both devices. Browser automation here could only test mocked peer sequencing, not a genuine routed LAN path.

To collect follow-up evidence, open **诊断** next to the online device count and use **复制诊断** separately on each device. The copied report excludes room code, member names, file names, and network IP addresses. Record whether the status says 房间已连接, 直连未就绪 or 文件直连就绪; also record whether the uploader's file shows 等待设备直连 or 可供 N 台设备接收. Do not infer that "房间已连接" means the file path is ready. The approved restricted host-only P2P policy is active; it is not a physical LAN guarantee.

| Case | Setup | Expected outcome | Status |
|---|---|---|---|
| P2P-01 | Two real devices on same Wi-Fi/router with a direct host pair | Join same room, accept masked host addresses, share and download a 1 MB test file; verify saved hash | **Partial: user-reported bidirectional transfer successful**; exact file size, download/hash and network characteristics still to verify |
| P2P-02 | Two different Wi-Fi networks with internet | Verify no cloud relay; host-only peer connectivity may succeed or fail. Record actual path and warn that physical LAN isolation is not guaranteed | Not run |
| LAN-03 | Two devices on guest Wi-Fi with AP/client isolation | Cannot establish direct connection; clear error | Not run |
| LAN-04 | Two devices on a VPN exposing similar private IP ranges | Observe and assess whether route heuristic can give false positives | Not run |
| P2P-05 | Selected pair exposes global IPv6, relay or reflexive candidates | Reject transfer; no cloud relay or file content | Policy unit tested; field pending |
| P2P-06 | Selected host pair contains a browser-masked/mDNS address | Allow encrypted P2P transfer if the other safety checks pass; do not claim LAN-only routing | Policy unit tested; real devices pending |
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
