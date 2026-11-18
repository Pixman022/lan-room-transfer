# LAN Room Transfer

Browser-based local network file transfer proof of concept.

This is an independent project, unrelated to Fresnica.

> Development prototype. LAN-only route enforcement and real-device file transfer have not been validated yet. Do not use for sensitive files.

The app requires a running Python/WebSocket signaling service, so GitHub Pages alone cannot host it. See `render.yaml` and `docs/deploy.md` once the full source has been committed.

User requirements: one-button room entry (auto-create or join), random 4-digit room codes, custom alphanumeric rooms, English color+animal device names, warm pale-orange UI, device-to-device file offers, individual receive and receive-all, and receiver-side sequential queue.
