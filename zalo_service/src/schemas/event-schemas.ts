import { z } from 'zod';

/**
 * Event schemas for Redis pub/sub messages between Node zalo_service and Rails.
 * Rails ZaloEventSubscriber parses incoming raw JSON against these shapes.
 *
 * Channel: `zalo.events`
 */

const baseEvent = z.object({
  session_id: z.string().uuid(),
  timestamp: z.string().datetime(),
});

export const qrCodeEvent = baseEvent.extend({
  type: z.literal('qr_code'),
  qr_base64: z.string(),
  expires_at: z.string().datetime(),
});

export const qrExpiredEvent = baseEvent.extend({
  type: z.literal('qr_expired'),
});

export const sessionReadyEvent = baseEvent.extend({
  type: z.literal('session_ready'),
  own_id: z.string(),
  display_name: z.string().optional(),
  avatar_url: z.string().optional(),
});

export const sessionDisconnectedEvent = baseEvent.extend({
  type: z.literal('session_disconnected'),
  reason: z.enum([
    'cookie_expired',
    'banned',
    'manual',
    'network',
    'heartbeat_failed',
    'listener_closed',
    'unknown',
  ]),
  recoverable: z.boolean(),
  error_message: z.string().optional(),
});

export const incomingMessageEvent = baseEvent.extend({
  type: z.literal('message'),
  payload: z.record(z.unknown()),
  historical: z.boolean().optional(),
});

export const threadListItemEvent = baseEvent.extend({
  type: z.literal('thread_list_item'),
  thread_id: z.string(),
  thread_type: z.number().int(), // 0 = user, 1 = group
  display_name: z.string(),
  avatar_url: z.string().optional(),
  zalo_user_id: z.string().optional(), // present for 1:1
  member_count: z.number().int().optional(), // present for groups
});

export const syncProgressEvent = baseEvent.extend({
  type: z.literal('sync_progress'),
  stage: z.enum(['threads', 'group_history', 'done', 'failed']),
  processed: z.number().int(),
  total: z.number().int().optional(),
  error_message: z.string().optional(),
});

export const messageDeliveryErrorEvent = baseEvent.extend({
  type: z.literal('message_delivery_error'),
  thread_id: z.string(),
  error: z.string(),
});

export const zaloEventSchema = z.discriminatedUnion('type', [
  qrCodeEvent,
  qrExpiredEvent,
  sessionReadyEvent,
  sessionDisconnectedEvent,
  incomingMessageEvent,
  messageDeliveryErrorEvent,
  threadListItemEvent,
  syncProgressEvent,
]);

export type ZaloEvent = z.infer<typeof zaloEventSchema>;
export type QrCodeEvent = z.infer<typeof qrCodeEvent>;
export type SessionReadyEvent = z.infer<typeof sessionReadyEvent>;
export type SessionDisconnectedEvent = z.infer<typeof sessionDisconnectedEvent>;
export type IncomingMessageEvent = z.infer<typeof incomingMessageEvent>;
