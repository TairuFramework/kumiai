---
"@kumiai/mls": patch
---

Require controller-signed holder evidence for chained leaf capabilities and preserve it through credential parsing and renewal. Evidence must be valid when the leaf capability is issued. Refuse empty invite recipient credential IDs.

Chained leaves without holder evidence are now refused in every group, including lifecycle and non-lifecycle groups. An existing member with such a leaf has its next commit refused, and a Welcome containing such a leaf fails. Members must renew their chained leaves with evidence before upgrading.
