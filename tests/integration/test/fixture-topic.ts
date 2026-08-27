/**
 * A schema-valid topicID: 43-char base64url, the shape the hub's enkaku server enforces — `serve`
 * auto-validates params against the protocol, which pins `topicID` to `^[A-Za-z0-9_-]{43}$`. These
 * suites publish through the real hub wire, so a readable literal like `'topic:smoke'` is rejected
 * with EK08 before any handler runs. Derive one from a readable label instead.
 *
 * The label is truncated to 32 bytes, so two labels sharing a 32-byte prefix collide. Keep labels
 * short and distinct wherever a test needs distinct topics; the ones in use here are.
 */
export function fixtureTopic(label: string): string {
  const bytes = new Uint8Array(32)
  bytes.set(new TextEncoder().encode(label).subarray(0, 32))
  return Buffer.from(bytes).toString('base64url')
}
