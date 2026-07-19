---
'@kumiai/hub-client': patch
---

Export `SubscribeOptions`, `FetchTopicParams`, `FetchTopicResult` and `ReceiveOptions`. All
four appear in `HubClient`'s public method signatures, so a consumer could not name the
argument or result type of `subscribe`, `fetchTopic` or `receive` without reaching into
`lib/`.
