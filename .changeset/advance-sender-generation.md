---
"@kumiai/mls": patch
---

Add `GroupHandle.advanceSenderGeneration(target)`: move this member's own application ratchet so the next `encrypt` uses generation `target`, at one KDF step per skipped generation instead of one empty encrypt each. The resulting state is the one the same number of empty encrypts leaves (retired chain secrets zeroed, epoch and other members untouched); a target at or below the current generation is a no-op, and it refuses exactly where `encrypt` does.
