import type { ZaloFactory, ZaloLike } from './zalo-login-flow.js';
import * as zcaJs from 'zca-js';

// zca-js publishes its Zalo class via named export. TypeScript can't always
// narrow the namespace import to the right constructor type due to its dual
// CJS/ESM packaging, so we grab it through an unknown cast.
const ZaloCtor = (zcaJs as unknown as { Zalo: new () => unknown }).Zalo;

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
    return new ZaloCtor() as ZaloLike;
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
}): Promise<unknown> {
  const zalo = new ZaloCtor() as {
    login: (c: {
      cookie: unknown;
      imei: string;
      userAgent: string;
    }) => Promise<unknown>;
  };
  // zca-js accepts cookie in several shapes (SerializedCookie[] | Cookie[] |
  // { url, cookies }). We pass whatever Rails stored and let the library
  // normalise internally.
  return zalo.login({
    cookie: credentials.cookie,
    imei: credentials.imei,
    userAgent: credentials.userAgent,
  });
}
