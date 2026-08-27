---
"@kumiai/hub-protocol": minor
---

Constrain the `topicID` schema to `^[A-Za-z0-9_-]{43}$` — the exact shape every topicID already
has (`toB64U` of a 32-byte HKDF/SHA-256 output). Applied to all six sites: the publish, subscribe,
unsubscribe and topic/fetch params, plus the topic/fetch result frame and the receive channel frame. This guarantees
every schema-legal `topicID` fits the fixed-size RFC 8291 wake-hint seal record; previously a
JSON-escape-heavy 256-code-point string was `minLength`/`maxLength`-legal but unsealable. Narrowing
an existing schema is a breaking change for any caller sending a value outside the new pattern, so
it ships as a minor band move rather than a patch.
