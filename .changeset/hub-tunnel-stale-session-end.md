---
"@kumiai/hub-tunnel": patch
---

Report a dropped session-end from another session as `frame-dropped` with the new reason `stale-session-end`. This happens when a peer ends a session and dials again before the other side's session-end arrives. Frames of any other kind from another session still report `session-mismatch`. The frame is still dropped and acknowledged as before.
