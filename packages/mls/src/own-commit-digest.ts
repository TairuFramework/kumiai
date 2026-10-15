import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import {
  contentTypes,
  decode,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  wireformats,
} from 'ts-mls'

/** Recognition only: never replace saved publication or application bytes. */
export function ownCommitDigest(commit: Uint8Array): string | null {
  try {
    const message = decode(mlsMessageDecoder, commit)
    if (
      message == null ||
      (message.wireformat === wireformats.mls_private_message
        ? message.privateMessage.contentType !== contentTypes.commit
        : message.wireformat !== wireformats.mls_public_message ||
          message.publicMessage.content.contentType !== contentTypes.commit)
    )
      return null
    return toB64U(sha256(encode(mlsMessageEncoder, message)))
  } catch {
    return null
  }
}
