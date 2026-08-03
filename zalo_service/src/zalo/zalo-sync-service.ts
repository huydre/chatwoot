import { childLogger } from '../logger.js';
import { publishEvent } from '../redis/event-publisher.js';
import type { SessionContext } from '../sessions/session-context.js';

/**
 * Historical sync for a Zalo session.
 *
 * zca-js limitations (verified against upstream src/apis):
 *   - Group chat history IS available via api.getGroupChatHistory
 *   - 1:1 chat history is NOT — Zalo Web simply does not expose it
 *
 * Strategy:
 *   1. Fetch all friends and all groups via metadata APIs
 *   2. Publish one `thread_list_item` event per friend/group so Rails
 *      can create placeholder Contact + Conversation rows
 *   3. For each group, pull recent messages via getGroupChatHistory and
 *      republish them as regular `message` events with `historical: true`
 *   4. Rails IncomingMessageService already dedupes by source_id so
 *      running sync multiple times is idempotent
 *
 * Rate limiting: fetches are sequential with a small sleep between each
 * so we do not trip Zalo's anti-bot heuristics. The caller receives a
 * response immediately and the actual work runs in the background.
 */

const log = childLogger({ component: 'zalo-sync-service' });

const GROUP_HISTORY_COUNT = 50;
const SLEEP_BETWEEN_CALLS_MS = 500;

interface ZcaApiForSync {
  getAllFriends?: () => Promise<unknown[]>;
  // getAllGroups returns { version, gridVerMap: { [id]: version } }
  getAllGroups?: () => Promise<{ gridVerMap?: Record<string, string> } | unknown>;
  // getGroupInfo accepts an array of ids and returns full metadata
  getGroupInfo?: (ids: string[]) => Promise<{
    gridInfoMap?: Record<string, Record<string, unknown>>;
  } | unknown>;
  // getGroupMembersInfo resolves member uids to { displayName, zaloName, avatar }
  getGroupMembersInfo?: (ids: string[]) => Promise<{
    profiles?: Record<
      string,
      { displayName?: string; zaloName?: string; avatar?: string }
    >;
  } | unknown>;
  getGroupChatHistory?: (groupId: string, count?: number) => Promise<{
    groupMsgs?: unknown[];
    more?: number;
  }>;
}

// In-memory sync job tracking. Keyed by session_id so we do not start
// two syncs on the same session concurrently.
const activeJobs = new Map<string, { startedAt: number; stage: string }>();

export function getSyncStatus(sessionId: string): { running: boolean; stage?: string } {
  const job = activeJobs.get(sessionId);
  if (!job) return { running: false };
  return { running: true, stage: job.stage };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startSync(
  ctx: SessionContext,
  opts: { includeGroupHistory?: boolean } = {},
): Promise<{ started: boolean; reason?: string }> {
  if (activeJobs.has(ctx.sessionId)) {
    return { started: false, reason: 'already_running' };
  }
  if (ctx.state !== 'ready' || !ctx.api) {
    return { started: false, reason: 'session_not_ready' };
  }

  activeJobs.set(ctx.sessionId, {
    startedAt: Date.now(),
    stage: 'starting',
  });

  // Fire and forget. Errors are caught internally so the promise never rejects.
  void runSync(ctx, opts).finally(() => {
    activeJobs.delete(ctx.sessionId);
  });

  return { started: true };
}

async function runSync(
  ctx: SessionContext,
  opts: { includeGroupHistory?: boolean },
): Promise<void> {
  const api = ctx.api as unknown as ZcaApiForSync;
  const sessionId = ctx.sessionId;

  try {
    // ---- Stage 1: thread list ---------------------------------------------
    updateStage(sessionId, 'threads');

    const friends = await safeCall('getAllFriends', () =>
      api.getAllFriends?.() ?? Promise.resolve([]),
    );
    const friendList = Array.isArray(friends) ? friends : [];

    // Two-step group fetch: getAllGroups gives us only {id: version}, then
    // getGroupInfo(ids) returns the actual metadata needed for display.
    const groupIdListRaw = await safeCall('getAllGroups', () =>
      api.getAllGroups?.() ?? Promise.resolve({}),
    );
    const groupIds = extractGroupIds(groupIdListRaw);
    let groupList: Array<Record<string, unknown>> = [];
    if (groupIds.length > 0 && api.getGroupInfo) {
      const groupInfoRaw = await safeCall('getGroupInfo', () =>
        api.getGroupInfo!(groupIds),
      );
      groupList = normalizeGroups(groupInfoRaw);
    }

    log.info(
      { session_id: sessionId, friends: friendList.length, groups: groupList.length },
      'sync: thread list fetched',
    );

    let processed = 0;
    const total = friendList.length + groupList.length;

    for (const friend of friendList) {
      await publishFriendItem(sessionId, friend);
      processed += 1;
    }
    for (const group of groupList) {
      await publishGroupItem(sessionId, group);
      processed += 1;
    }

    void publishEvent({
      type: 'sync_progress',
      session_id: sessionId,
      stage: 'threads',
      processed,
      total,
    });

    // ---- Stage 2: group history ------------------------------------------
    if (opts.includeGroupHistory && groupList.length > 0) {
      updateStage(sessionId, 'group_history');
      let historyProcessed = 0;

      for (const group of groupList) {
        const groupId = extractGroupId(group);
        if (!groupId) continue;

        // Resolve member uid → name map so historical messages can
        // show real sender names instead of "Zalo User 938617".
        const memberMap = await fetchMemberNameMap(api, group);

        try {
          const history = await api.getGroupChatHistory?.(groupId, GROUP_HISTORY_COUNT);
          const msgs = Array.isArray(history?.groupMsgs) ? history.groupMsgs : [];
          for (const msg of msgs) {
            await publishHistoricalMessage(sessionId, msg, memberMap);
          }
          historyProcessed += 1;
          log.debug(
            { session_id: sessionId, group_id: groupId, messages: msgs.length },
            'sync: group history fetched',
          );
        } catch (err) {
          log.warn(
            {
              session_id: sessionId,
              group_id: groupId,
              err: err instanceof Error ? err.message : String(err),
            },
            'sync: group history fetch failed',
          );
        }

        await sleep(SLEEP_BETWEEN_CALLS_MS);
      }

      void publishEvent({
        type: 'sync_progress',
        session_id: sessionId,
        stage: 'group_history',
        processed: historyProcessed,
        total: groupList.length,
      });
    }

    // ---- Done -------------------------------------------------------------
    updateStage(sessionId, 'done');
    void publishEvent({
      type: 'sync_progress',
      session_id: sessionId,
      stage: 'done',
      processed: 0,
    });
    log.info({ session_id: sessionId }, 'sync: completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ session_id: sessionId, err: msg }, 'sync: failed');
    void publishEvent({
      type: 'sync_progress',
      session_id: sessionId,
      stage: 'failed',
      processed: 0,
      error_message: msg,
    });
  }
}

function updateStage(sessionId: string, stage: string): void {
  const job = activeJobs.get(sessionId);
  if (job) job.stage = stage;
}

async function safeCall<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    log.warn(
      { label, err: err instanceof Error ? err.message : String(err) },
      'sync: api call failed',
    );
    return null;
  }
}

/**
 * zca-js getAllGroups returns { version, gridVerMap: { id: version } }.
 * This helper extracts just the ids so we can call getGroupInfo() next.
 */
function extractGroupIds(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const map = obj.gridVerMap;
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map as Record<string, unknown>);
}

/**
 * getGroupInfo(ids) returns { gridInfoMap: { id: GroupInfo & {...} } }.
 * Returns a flat list with id spliced in alongside the rest of the fields.
 */
function normalizeGroups(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const map = obj.gridInfoMap;
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map as Record<string, unknown>).map(([id, info]) => ({
    id,
    ...(info as Record<string, unknown>),
  }));
}

function extractGroupId(group: Record<string, unknown>): string | null {
  const id = group.id ?? group.groupId ?? group.grid;
  return typeof id === 'string' ? id : null;
}

async function publishFriendItem(
  sessionId: string,
  friend: unknown,
): Promise<void> {
  const f = friend as Record<string, unknown>;
  const userId = (f.userId ?? f.uid ?? f.zaloId) as string | undefined;
  if (!userId) return;
  const displayName =
    (f.zaloName as string | undefined) ||
    (f.displayName as string | undefined) ||
    (f.dName as string | undefined) ||
    `Zalo ${String(userId).slice(-6)}`;

  await publishEvent({
    type: 'thread_list_item',
    session_id: sessionId,
    thread_id: userId,
    thread_type: 0,
    display_name: displayName,
    avatar_url: (f.avatar as string | undefined) ?? undefined,
    zalo_user_id: userId,
  });
}

async function publishGroupItem(
  sessionId: string,
  group: Record<string, unknown>,
): Promise<void> {
  const gid = extractGroupId(group);
  if (!gid) return;
  const name =
    (group.name as string | undefined) ||
    (group.groupName as string | undefined) ||
    `Zalo Group ${gid.slice(-6)}`;
  const members = group.memberIds as unknown[] | undefined;

  await publishEvent({
    type: 'thread_list_item',
    session_id: sessionId,
    thread_id: gid,
    thread_type: 1,
    display_name: name,
    avatar_url: (group.avt as string | undefined) ?? undefined,
    member_count: Array.isArray(members) ? members.length : undefined,
  });
}

async function publishHistoricalMessage(
  sessionId: string,
  rawMsg: unknown,
  memberMap?: Record<string, { name: string; avatar?: string }>,
): Promise<void> {
  const msg = rawMsg as Record<string, unknown>;
  const data = (msg.data as Record<string, unknown>) ?? {};
  const uidFrom = (data.uidFrom as string | undefined) ?? undefined;

  // Enrich with resolved member name + avatar when possible so Rails
  // does not have to fall back to "Zalo User XXX".
  if (memberMap && uidFrom && memberMap[uidFrom]) {
    if (!data.dName || typeof data.dName !== 'string' || data.dName.length === 0) {
      data.dName = memberMap[uidFrom].name;
    }
    if (!data.avatar && memberMap[uidFrom].avatar) {
      data.avatar = memberMap[uidFrom].avatar;
    }
    msg.data = data;
  }

  await publishEvent({
    type: 'message',
    session_id: sessionId,
    payload: msg,
    historical: true,
  });
}

/**
 * Fetch getGroupMembersInfo for the group's memVerList and return a
 * simple uid → {name, avatar} map. Returns {} on any failure so the
 * caller falls back to the existing placeholder name behaviour.
 */
async function fetchMemberNameMap(
  api: ZcaApiForSync,
  group: Record<string, unknown>,
): Promise<Record<string, { name: string; avatar?: string }>> {
  const memberIds = Array.isArray(group.memVerList)
    ? (group.memVerList as unknown[])
        .map((m) => (typeof m === 'string' ? m.split('_')[0] : null))
        .filter((x): x is string => Boolean(x))
    : [];
  if (memberIds.length === 0 || !api.getGroupMembersInfo) return {};

  try {
    const resp = (await api.getGroupMembersInfo(memberIds)) as {
      profiles?: Record<
        string,
        { displayName?: string; zaloName?: string; avatar?: string }
      >;
    };
    const profiles = resp?.profiles ?? {};
    const out: Record<string, { name: string; avatar?: string }> = {};
    for (const [rawId, prof] of Object.entries(profiles)) {
      const uid = rawId.split('_')[0];
      const name = prof?.displayName || prof?.zaloName || `Zalo ${uid.slice(-6)}`;
      out[uid] = { name, avatar: prof?.avatar };
    }
    return out;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'fetchMemberNameMap failed',
    );
    return {};
  }
}
