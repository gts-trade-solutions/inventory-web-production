import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { readZiotPayload } from '@/lib/devices/ziot/payload'
import { recordTagReads } from '@/lib/services/counts'
import { ApiError, ErrorCode } from '@/lib/api/errors'

const schema = z.object({
  /** The open count session these reads belong to. */
  sessionId: z.string().uuid(),
  /** Whatever the reader sent. Shapes vary by firmware, so it is not narrowed. */
  payload: z.unknown(),
})

/**
 * Tag reads pushed by a Zebra IoT Connector reader.
 *
 * ZIoT firmware can publish over MQTT, WebSocket or plain HTTP. This is the
 * HTTP path, which needs nothing installed on our side — a reader configured to
 * POST here streams straight into an open count.
 *
 * MQTT is deliberately not wired up yet: the broker, the topic layout and the
 * credentials are site decisions that cannot be made before bring-up (Q7). The
 * part that would be WRONG — reading the firmware's JSON — is shared, so
 * adding the MQTT transport later is a subscription that calls the same parser.
 *
 * `skipped` is returned rather than swallowed. An entry we could not read is a
 * tag that was physically present and is about to be counted as missing.
 */
export const POST = apiRoute({ schema }, async ({ db, body }) => {
  const { reads, skipped, reader } = readZiotPayload(body.payload)

  if (reads.length === 0 && skipped.length > 0) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      'None of those reads could be used. Check the reader is sending EPC data.',
      { skipped },
    )
  }

  const outcome = await recordTagReads(
    db,
    body.sessionId,
    reads.map((read) => ({ epc: read.epc, rssi: read.rssi, readAt: read.at })),
  )

  return {
    reader,
    received: reads.length,
    ...outcome,
    skipped,
  }
})
