---
"@kumiai/mls": patch
---

In lifecycle groups, revoking a trusted agent no longer cascades to a child leaf that carries its holder's own valid controller grant. Such a child stays valid for commits and Welcomes with its unchanged credential, while new capabilities from the revoked agent are still refused. A direct controller capability may replace a leaf issued by an agent the group recorded revoked, even when the current leaf's capability is newer.
