# POC field test matrix

Status: **not executed** on actual two-device LAN. These are the acceptance gates for the next stage.

| Case | Setup | Expected outcome | Status |
|---|---|---|---|
| LAN-01 | Two real devices on the same Wi-Fi/router, distinct private IPv4 in same /24 | Join same room, verify peer candidates, transfer sample file | Not run |
| LAN-02 | Two different Wi-Fi networks with internet | Can reach signalling server but **must not** transfer file bytes | Not run |
| LAN-03 | Two devices on guest Wi-Fi with AP/client isolation | Cannot establish direct connection; clear error | Not run |
| LAN-04 | Two devices on a VPN exposing similar private IP ranges | Observe and assess whether route heuristic can give false positives | Not run |
| LAN-05 | IPv6 enabled, global addresses available | No file content sent via global IPv6 or relay | Not run |
| LAN-06 | Browser reveals mDNS `.local` candidate instead of IPv4 | Deny file transfer and explain compatibility limitation | Not run |
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
| FILE-01 | Receiver clicks one file's Receive | Only that file is transferred | Browser pending |
| FILE-02 | Receiver clicks Receive All | Remaining files transferred sequentially | Browser pending |
| FILE-03 | Cancel, disconnect, retry | Clear states; no data mixed between jobs | Browser pending |
| FILE-04 | 10 MB, then 100 MB, then 1 GB | Track time, memory and save success; larger files are **future** goals | 10 MB possible within cap, live test pending; others unsupported |
| MOBILE-01 | Android Chrome | Join, share files directly, receive, save | Not run |
| MOBILE-02 | iOS Safari | Join, share files directly, receive, save | Not run |

For every test record: browser/version, operating system, selected ICE candidate types/addresses (redacted), route verdict, bytes actually sent, file hash verification, user-visible error, and pass/fail. Do not collect filenames or file bytes in public service logs.

Offline UI interaction harness (`python tests/offline_room_ui.py`) uses mocked peer connections, not real signalling or file bytes. It checks room entry, English names and animal avatars, sharing before any peers arrive, room-wide file announcements, late-join synchronization, withdrawal, single/receive-all controls, sequential queue, inline rename, and mobile/desktop overflow; screenshots in `docs/*-static.png` reflect this test fixture only.
