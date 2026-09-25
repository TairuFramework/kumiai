---
"@kumiai/mls-rpc": patch
---

Reject non-Commit bytes on the commit topic before they reach the MLS handle. This prevents stray Proposals from entering the next authored Commit and keeps peers that missed them able to apply it.
