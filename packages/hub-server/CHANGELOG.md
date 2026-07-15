# @kumiai/hub-server

## 0.3.0

### Minor Changes

- 70634ac: BREAKING (lockstep with `@kumiai/hub-protocol`): the store implements the new `HubStore` contract — log/mailbox retention classes, stored `head`, `fetchTopic`, `trim`, and class-scoped trim and depth eviction (a mailbox flood can no longer evict a group's commit log). A deduped publish is no longer re-fanned to subscribers.

### Patch Changes

- Updated dependencies [70634ac]
- Updated dependencies [70634ac]
  - @kumiai/hub-protocol@0.3.0
  - @kumiai/mls@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [03a60d2]
- Updated dependencies [1ef7feb]
  - @kumiai/mls@0.2.0
