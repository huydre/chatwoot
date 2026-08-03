import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ThreadType, type AttachmentSource } from 'zca-js';

import { childLogger } from '../../logger.js';
import { getSessionManager } from '../../sessions/session-manager.js';

/**
 * Outbound: Rails agent reply → Zalo.
 *
 * This endpoint was a `501 not_implemented_phase_02` stub, so replying from
 * Chatwoot silently did nothing: SendOnZaloService marked the message failed
 * with that string as the external error, and nothing else surfaced it.
 *
 * Attachments arrive as URLs pointing back at Chatwoot's blob storage, and
 * zca-js wants either a local path or the bytes, so they are fetched here.
 *
 * Not handled: quoting. Rails passes reply_to as a bare message id, but
 * zca-js's quote wants the whole original message (content, msgType, ts,
 * cliMsgId...). Sending a malformed quote fails the whole message, so the
 * reply is sent unquoted rather than not at all.
 */

const log = childLogger({ component: 'send-routes' });
export const sendRouter = Router();

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const sendSchema = z.object({
  session_id: z.string().min(1),
  thread_id: z.string().min(1),
  thread_type: z.number().int().optional(),
  content: z.string().optional(),
  attachments: z
    .array(
      z.object({
        url: z.string().url(),
        filename: z.string().optional(),
        type: z.string().optional(),
      }),
    )
    .optional(),
  reply_to: z.union([z.string(), z.number()]).nullish(),
});

// zca-js types the filename as `${string}.${string}`, and derives the upload
// kind from the extension, so anything without one has to get a plausible one.
function ensureExtension(name: string, contentType: string): `${string}.${string}` {
  if (/\.[a-z0-9]+$/i.test(name)) return name as `${string}.${string}`;

  const fromType = contentType.split('/')[1]?.split(';')[0];
  return `${name || 'attachment'}.${fromType && /^[a-z0-9]+$/i.test(fromType) ? fromType : 'bin'}`;
}

async function fetchAttachment(
  url: string,
  filename?: string,
): Promise<AttachmentSource> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`attachment fetch failed: ${res.status}`);

  const size = Number(res.headers.get('content-length') ?? 0);
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment too large: ${size} bytes`);
  }

  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment too large: ${data.byteLength} bytes`);
  }

  return {
    data,
    filename: ensureExtension(
      filename ?? url.split('/').pop() ?? 'attachment',
      res.headers.get('content-type') ?? '',
    ),
    metadata: { totalSize: data.byteLength },
  };
}

sendRouter.post('/', async (req: Request, res: Response) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
    return;
  }

  const { session_id: sessionId, thread_id: threadId } = parsed.data;
  const ctx = getSessionManager().get(sessionId);
  if (!ctx?.api) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }

  const content = parsed.data.content?.trim() ?? '';
  let attachments: AttachmentSource[] = [];
  try {
    attachments = await Promise.all(
      (parsed.data.attachments ?? []).map((a) => fetchAttachment(a.url, a.filename)),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ session_id: sessionId, reason }, 'send: attachment fetch failed');
    res.status(502).json({ error: `attachment_fetch_failed: ${reason}` });
    return;
  }

  if (!content && attachments.length === 0) {
    res.status(400).json({ error: 'empty_message' });
    return;
  }

  try {
    const result = await ctx.api.sendMessage(
      {
        msg: content,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      threadId,
      parsed.data.thread_type === 1 ? ThreadType.Group : ThreadType.User,
    );

    // Rails stores this as the message's source_id, which is what dedupes the
    // echo when Zalo pushes this same message back over the listener.
    const messageId =
      result?.message?.msgId ?? result?.attachment?.[0]?.msgId ?? null;

    if (messageId === null) {
      log.error({ session_id: sessionId, thread_id: threadId }, 'send: no msgId returned');
      res.status(502).json({ error: 'no_message_id_returned' });
      return;
    }

    log.info(
      { session_id: sessionId, thread_id: threadId, msg_id: messageId, attachments: attachments.length },
      'send: delivered',
    );
    res.json({ message_id: String(messageId) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ session_id: sessionId, thread_id: threadId, reason }, 'send: failed');
    res.status(502).json({ error: reason });
  }
});
