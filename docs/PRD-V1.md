# LAN Room Product Requirements V1.0 — Confirmed Baseline

**Project:** independent browser LAN file transfer tool, not Fresnica. Name provisional. 2026-11-18.

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
- Exit at will. Creator departure never closes a room with other connected users. When the last device disconnects, keep a **2-minute reconnection window**, then close the room.
- If the page reloads while a session exists, show that room code for re-entry and silently restore the previous member identity when the session token is still valid. The random numeric code has no separate five-minute joining cutoff.
- Use rooms without administrators, while maintaining local peer-blocking, request rate limits and explicit file acceptance.

## Nonnegotiable network boundary

Internet is allowed for accessing the HTTPS page and performing initial signalling/room coordination only. Actual file content must only traverse a direct local connection between devices. No public file relays or cloud storage. If the browser cannot verify a qualifying path, fail closed instead of guessing.

**Critical open risk:** Browser-only checks cannot prove physical LAN routing with complete certainty. The product promise is *not yet validated*; this must be resolved before production release.

## First delivery scope

- Warm light-orange theme (replacing the previous green), off-white background, rounded white cards, soft orange accents, animal avatars, and minimal instructional text. Reference style is friendly and spacious, not a direct brand or asset copy.
- Compact home and room workspace: presence-only online device list left, shared file drop area on the right, room-wide file catalog with per-file receive/receive-all, sequential receiver queue, and compact device rename. No recipient selection or separate send confirmation.
- Desktop and mobile responsive UI.
- User-visible invalid-code, room-full, not-connected, route-blocked and transfer-failed states.
- Initial supported environment: different devices under the same router and directly reachable private IPv4 network.
- Do not require complex subnet routing or full offline pairing in the first version.

## Deferred

Account systems, persistent room ownership, multi-file concurrent transfer to the same receiver, public WAN file relay, cloud storage, large-file resume, complex folder sync, chat, permanent server history. Optional QR join and file picker enhancements should be designed after path feasibility is established.

## Stage gates

1. P0: Signalling room state, reconnection, no admin and code rules.
2. P0: Browser-borne path inspection, negatives for distinct networks/VPN/public IPv6, clear fail-closed behavior.
3. P1: Real multi-device transfer, sequential file state, cancellation, file-content hash checks.
4. P1: Android/iOS browser download and memory handling.
5. Only then: final interactive UX, design system, deployment hardening and V1 release.
