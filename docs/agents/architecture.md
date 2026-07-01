# Architecture

kumiai (組合, "union / cooperative") is the MLS group-messaging layer -- the top of the stack.

## Packages

mls (E2EE identity + membership via MLS -- the crypto core), broadcast (generic fan-out),
the hub subsystem (hub-protocol, hub-client, hub-server, hub-tunnel), and rpc. Locked group
while pre-1.0 (young, tightly coupled).

## Position in the stack

Depends downward on sozai, kokuin, and enkaku; nothing depends on kumiai. See the stack
overview: https://github.com/TairuFramework/kigu/blob/main/docs/stack.md
