---
'@kumiai/hub-server': patch
---

`hub/v1/receive` now paces delivery by acks: at most `receiveWindow` frames (default 256) and `receiveWindowBytes` bytes (default 512 KiB) are written to a channel and not yet acked, and the ack loop runs from connect instead of after the backlog drain. Before, the drain wrote a whole backlog at once; `@enkaku/http-serve` drops an SSE session whose unread buffer passes `maxSessionBufferBytes`, so a backlog larger than that buffer, read by a slow client, ended the session on every connect before any ack landed, and the next connect redelivered the identical backlog. A full window with no ack for `receiveAckTimeout` (default 60 s, restarted by every ack) tears the channel down; its frames stay pending. Abort and eviction now also end a channel that is still draining. New exports: `DEFAULT_RECEIVE_WINDOW`, `DEFAULT_RECEIVE_WINDOW_BYTES`, `DEFAULT_RECEIVE_ACK_TIMEOUT`.
