---
'@kumiai/hub-server': patch
---

Log receive ack timeouts at warning level with the recipient DID, outstanding frame and byte counts, and timeout duration. Log delivery pauses and streams ending with unacked frames at debug level under `['kumiai', 'hub-server', 'receive']`. Payloads and keys are never logged.
