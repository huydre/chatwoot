import type { API, Credentials } from 'zca-js';
import { Zalo } from 'zca-js';

import type { ZaloFactory, ZaloLike } from './zalo-login-flow.js';

/**
 * Construction of the real zca-js client.
 *
 * `selfListen` is the important bit. Without it the listener drops every
 * message the logged-in account sent — zca-js checks
 * `if (messageObject.isSelf && !this.selfListen) continue;` — so anything the
 * user typed in the Zalo app itself never reached Chatwoot, and the agent's
 * own half of each conversation was missing. Chatwoot needs those events;
 * the echo of a reply it sent is separated out later by source_id.
 */
const CLIENT_OPTIONS = { selfListen: true } as const;

/**
 * Default ZaloFactory that returns a real zca-js `Zalo` instance.
 *
 * This adapter layer lets tests inject a fake factory (see
 * tests/zalo-login-flow.spec.ts) while production code uses the real library.
 *
 * A new Zalo instance is created per login flow because zca-js stores the
 * login context on the instance itself — sharing across sessions would
 * cross-contaminate cookies.
 */
export class DefaultZaloFactory implements ZaloFactory {
  create(): ZaloLike {
    return new Zalo(CLIENT_OPTIONS);
  }
}

/**
 * Re-login with previously-persisted credentials.
 * Used by session-bootstrap on startup to restore ready sessions without
 * requiring the user to scan a new QR.
 */
export async function reloginWithCredentials(credentials: {
  cookie: unknown;
  imei: string;
  userAgent: string;
}): Promise<API> {
  const zalo = new Zalo(CLIENT_OPTIONS);

  // zca-js accepts cookie in several shapes (SerializedCookie[] | Cookie[] |
  // { url, cookies }). We pass whatever Rails stored and let the library
  // normalise internally.
  return zalo.login({
    cookie: credentials.cookie,
    imei: credentials.imei,
    userAgent: credentials.userAgent,
  } as Credentials);
}
