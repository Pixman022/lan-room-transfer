# LAN Room Product Requirements V1.0 — Confirmed Baseline

**Project:** independent browser P2P file transfer tool, not Fresnica. Name provisional. 2026-11-18. **Network decision amended to restricted B mode on 2026-11-18.**

## What users must be able to do

- Open a public HTTPS website without registration, installing an app, or operating a local service.
- On the entry page, display the saved/random device name and a pre-generated **4-digit numeric room code**. Allow changing the room code into any **4–16-character case-insensitive alphanumeric** custom name/code. Offer a small regenerate action for another random numeric code.
- Show exactly **one prominent Enter Room action**. If the code does not refer to an active room, the first entrant creates it; otherwise the user joins the existing room automatically. Do not expose separate "Create" and "Join" actions.
- Reuse custom codes later without a permanent owner/account. A currently active code identifies only one room.
- The same entry rule applies to random and custom codes. Room code suggestions do not reserve a room in advance; another user can claim that code first. Let everyone with a room code enter without waiting for approval.
- Show an English **Color + Animal** device name by default (such as `Coral Fox` or `Silver Otter`), without a numeric suffix unless needed for future name-collision handling. Persist it in the current browser; allow edits before entering or inside a room. Changes appear to other members without changing underlying device identity.
- After entering a room, share files directly from a central drop zone or file picker, without selecting an individual receiver. Each verified connected member sees every online uploader's shared file list; members joining later receive the existing file catalog through direct peer channels. Sharing exposes only file metadata, not file contents, until each member chooses to receive. A shared file can be withdrawn by its uploader. If the uploader disconnects, their file list disappears and the file bytes become unavailable. No room file bytes or file metadata are intentionally stored by the public signalling server.
- Receive individual files by clicking **Receive** next to the file or click **Receive All** for all remaining files in that offer. **No checkboxes, Select All, or Receive Selected.**
- Keep one active inbound transfer per receiving device; view file-level progress, cancel and retry failures.
- Download with default browser behavior, optionally choose a save location on browsers that support it.
- Exit at will. Creator departure never closes a room with other connected users. **When the last online device disconnects (voluntarily or unexpectedly), immediately close the now-empty room and release its code.** Re-entering the same code starts a fresh room; the previous server-side member identity cannot be restored. If any member remains online, reconnecting devices can join that existing room. A browser tab that remains open may preserve its locally staged File objects across automatic reconnection, but unfinished transfers restart from zero; no files or interrupted bytes are stored on the server.
- If the page reloads while a session exists, show the previous room code for re-entry. Silently restore the member identity **only if that original room is still alive** (at least one member remains online, or a rapid socket takeover completes before the final disconnect); otherwise join/create a new room with a new identity. A closed tab loses its in-memory File objects and requires reselecting files. The random numeric code has no separate five-minute joining cutoff.
- Use rooms without administrators, while maintaining local peer-blocking, request rate limits and explicit file acceptance.

## Approved network boundary — restricted P2P mode

Internet is allowed for the HTTPS website and room/signalling service. File metadata and contents move directly between browsers over WebRTC DataChannels, never through the signalling server or cloud file storage. No STUN/TURN servers are configured.

Require a selected `host`/`host` ICE candidate pair. Permit mDNS-hidden or redacted candidate addresses when both selected candidate types are confirmed `host`. Continue to reject relay/reflexive pairs, known public/unsupported addresses, known different private IPv4 /24 subnets and identical visible endpoints. If the browser cannot identify a selected pair and its types, fail closed.

**Confirmed trade-off:** The browser-only tool cannot guarantee file bytes remain on a physical LAN; host P2P may traverse a VPN or routed network. Replace any absolute LAN-only marketing statement with “device-to-device P2P transfer; file bytes are not uploaded to our server.” This choice was explicitly approved on 2026-11-18. Share files only with trusted room participants; four-digit room codes are guessable.

## First delivery scope

- Warm light-orange theme (replacing the previous green), off-white background, rounded white cards, soft orange accents, animal avatars, and minimal instructional text. Reference style is friendly and spacious, not a direct brand or asset copy.
- Compact home and room workspace: presence-only online device list left, shared file drop area on the right, room-wide file catalog with per-file receive/receive-all, sequential receiver queue, and compact device rename. No recipient selection or separate send confirmation.
- Desktop and mobile responsive UI.
- User-visible invalid-code, room-full, not-connected, route-blocked and transfer-failed states.
- Primary supported scenario: distinct devices with reachable P2P connections, preferably on the same router/Wi-Fi; physical LAN-only routing is not guaranteed.
- Do not require complex subnet routing or full offline pairing in the first version.

## Deferred

Account systems, persistent room ownership, multi-file concurrent transfer to the same receiver, public WAN file relay, cloud storage, large-file resume, complex folder sync, chat, permanent server history. Optional QR join and file picker enhancements should be designed after path feasibility is established.

## Stage gates

1. P0: Signalling room state, reconnection, no admin and code rules.
2. P0: Restricted host-only P2P inspection, negatives for relay/reflexive and explicitly unsafe visible paths, plus VPN/remote-route disclosures.
3. P1: Real multi-device transfer, sequential file state, cancellation, file-content hash checks.
4. P1: Android/iOS browser download and memory handling.
5. Only then: final interactive UX, design system, deployment hardening and V1 release.
