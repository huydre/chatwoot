import type { API } from 'zca-js';

import { childLogger } from '../logger.js';
import { publishEvent } from '../redis/event-publisher.js';
import type { SessionContext } from '../sessions/session-context.js';

/**
 * Historical sync for a Zalo session.
 *
 * What history is actually reachable (checked against zca-js 2.1.2, which is
 * the latest release):
 *   - 1:1 history: not exposed. None of the 148 API methods return it.
 *   - Group history: api.getGroupChatHistory exists but Zalo answers 404 for
 *     `/api/group/history`, while every other call on the same service host
 *     works — including getGroupInfo, which reports enableMsgHistory: 1 for
 *     the very groups whose history 404s. Upstream bug, still open:
 *     https://github.com/RFS-ADRENO/zca-js/issues/367
 *
 * So stage 2 below currently imports nothing. It is left wired up because the
 * call site is correct and will start working the day upstream is fixed, and
 * because it now reports the failure rather than quietly finishing.
 *
 * Strategy:
 *   1. Fetch all friends and all groups via metadata APIs
 *   2. Publish one `thread_list_item` event per friend/group so Rails
 *      can create the Contact
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
// Zalo rejects getGroupInfo outright once the id list gets long — an account
// in 113 groups got "Tham số không hợp lệ" for the whole call, so every group
// was lost rather than some. Zalo Web itself pages these, so we batch too.
const GROUP_INFO_BATCH_SIZE = 50;

// Calls go through zca-js's own API type. This file used to declare a local
// interface with every method optional, so the compiler checked the calls
// against a hand-written shape instead of the library — exactly the blind
// spot that hides an upstream signature change.
type ZcaApiForSync = API;

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
  opts: { includeGroupHistory?: boolean; groupLimit?: number } = {},
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
  opts: { includeGroupHistory?: boolean; groupLimit?: number },
): Promise<void> {
  const sessionId = ctx.sessionId;
  // startSync checked this, but the session can drop between the check and
  // this task actually running.
  const api: ZcaApiForSync | null = ctx.api;
  if (!api) {
    log.warn({ session_id: sessionId }, 'sync: session lost its api handle before the run started');
    return;
  }

  try {
    // ---- Stage 1: thread list ---------------------------------------------
    updateStage(sessionId, 'threads');

    const friends = await safeCall('getAllFriends', () =>
      api.getAllFriends(),
    );
    const friendList = Array.isArray(friends) ? friends : [];

    // Two-step group fetch: getAllGroups gives us only {id: version}, then
    // getGroupInfo(ids) returns the actual metadata needed for display.
    const groupIdListRaw = await safeCall('getAllGroups', () =>
      api.getAllGroups(),
    );
    const groupIds = extractGroupIds(groupIdListRaw);
    // Zalo rejects getGroupInfo with "Tham số không hợp lệ" for some accounts.
    // The ids come straight from getAllGroups, so log enough to tell whether
    // the shape changed or Zalo simply refuses these ids — without dumping
    // the whole response, which names every group the account belongs to.
    log.info(
      {
        session_id: sessionId,
        raw_keys: groupIdListRaw && typeof groupIdListRaw === 'object'
          ? Object.keys(groupIdListRaw as Record<string, unknown>)
          : typeof groupIdListRaw,
        group_id_count: groupIds.length,
        first_id_len: groupIds[0]?.length,
      },
      'sync: getAllGroups shape',
    );

    const groupList = await fetchGroupInfoInBatches(api, groupIds);

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
      let historyFailed = 0;
      let lastHistoryError: string | undefined;
      let importedMessages = 0;

      // Two Zalo calls per group, so an unbounded run on a large account is a
      // long burst of traffic. Callers can cap it and come back for the rest.
      const historyGroups = opts.groupLimit
        ? groupList.slice(0, opts.groupLimit)
        : groupList;
      if (historyGroups.length < groupList.length) {
        log.info(
          { session_id: sessionId, syncing: historyGroups.length, total: groupList.length },
          'sync: group history capped by group_limit',
        );
      }

      for (const group of historyGroups) {
        const groupId = extractGroupId(group);
        if (!groupId) continue;

        // Resolve member uid → name map so historical messages can
        // show real sender names instead of "Zalo User 938617".
        const memberMap = await fetchMemberNameMap(api, group);

        try {
          const history = await api.getGroupChatHistory(groupId, GROUP_HISTORY_COUNT);
          const msgs = Array.isArray(history?.groupMsgs) ? history.groupMsgs : [];
          for (const msg of msgs) {
            await publishHistoricalMessage(sessionId, msg, memberMap);
          }
          importedMessages += msgs.length;
          historyProcessed += 1;
          log.debug(
            { session_id: sessionId, group_id: groupId, messages: msgs.length },
            'sync: group history fetched',
          );
        } catch (err) {
          historyFailed += 1;
          lastHistoryError = err instanceof Error ? err.message : String(err);
          log.warn(
            { session_id: sessionId, group_id: groupId, err: lastHistoryError },
            'sync: group history fetch failed',
          );
        }

        await sleep(SLEEP_BETWEEN_CALLS_MS);
      }

      // Every group failing is the known upstream 404, not bad luck. Say so
      // instead of reporting a clean run that imported nothing.
      const allFailed = historyFailed > 0 && historyProcessed === 0;
      if (allFailed) {
        log.error(
          { session_id: sessionId, groups: historyFailed, err: lastHistoryError },
          'sync: group history unavailable for every group — see zca-js issue 367',
        );
      }

      void publishEvent({
        type: 'sync_progress',
        session_id: sessionId,
        stage: 'group_history',
        processed: historyProcessed,
        total: historyGroups.length,
        ...(allFailed
          ? { error_message: `group history unavailable (${lastHistoryError})` }
          : {}),
      });

      log.info(
        {
          session_id: sessionId,
          groups_ok: historyProcessed,
          groups_failed: historyFailed,
          messages_imported: importedMessages,
        },
        'sync: group history finished',
      );
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
 * Resolves group metadata in batches.
 *
 * One batch failing costs only that batch, so an account with a single
 * problematic group still syncs the rest — the previous single call meant
 * one bad id, or simply too many ids, lost every group.
 */
async function fetchGroupInfoInBatches(
  api: ZcaApiForSync,
  groupIds: string[],
): Promise<Array<Record<string, unknown>>> {
  const groups: Array<Record<string, unknown>> = [];

  for (let i = 0; i < groupIds.length; i += GROUP_INFO_BATCH_SIZE) {
    const batch = groupIds.slice(i, i + GROUP_INFO_BATCH_SIZE);
    const raw = await safeCall(`getGroupInfo[${i}..${i + batch.length - 1}]`, () =>
      api.getGroupInfo(batch),
    );
    groups.push(...normalizeGroups(raw));

    if (i + GROUP_INFO_BATCH_SIZE < groupIds.length) {
      await sleep(SLEEP_BETWEEN_CALLS_MS);
    }
  }

  return groups;
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
