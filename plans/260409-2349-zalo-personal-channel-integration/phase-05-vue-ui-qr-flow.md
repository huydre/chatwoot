# Phase 05 — Vue UI: Channel Card + QR Scan + Add Inbox Flow

## Context Links
- Plan: [plan.md](./plan.md)
- Prev: [phase-04-rails-services-listener.md](./phase-04-rails-services-listener.md)
- Next: [phase-06-logout-detection-reconnect.md](./phase-06-logout-detection-reconnect.md)
- Reference: `app/javascript/dashboard/routes/dashboard/settings/inbox/channels/Telegram.vue`, `ChannelList.vue`

## Overview
- **Priority:** P0
- **Status:** Todo
- **Description:** UI inbox setup + **proxy management** + **session reconnect banner**. User vào Settings → Inboxes → Add Inbox → chọn Zalo → (optional) pick proxy từ pool → scan QR → inbox tạo. Settings → Zalo Proxies page CRUD proxy. Dashboard shell hiện banner nếu có session expired. Vue 3 Composition API, Tailwind only, i18n en.json.

## Scope Expansion (from decisions)

Phase này giờ gồm **3 UI modules**:
1. **QR login flow** (Zalo.vue + sub-components) — nguyên bản
2. **Proxy management** (settings page + CRUD) — **MỚI** vì decision 1 (UI v1)
3. **Reconnect banner** (persistent dashboard banner) — **MỚI** vì decision 4

Group chat UI label (decision 2) — piggyback vào conversation list rendering, chỉ cần i18n string + icon variant.

## Key Insights

- Channel Vue naming = **PascalCase** per Chatwoot convention (`Telegram.vue`, `Line.vue`) → tạo `Zalo.vue`
- `ChannelFactory.vue` dispatch component theo sub_page param
- State machine ở frontend tương tự state ở Node — nhưng poll từ Rails API, không direct Node
- Polling interval: 1-2s (đủ responsive, không load nặng)
- Auto-refresh QR: nếu backend trả `expired` → auto-trigger start_login mới
- Sau `ready` → redirect `settings_inboxes_add_agents` giống Telegram.vue flow

## Requirements

### Functional

**Channel card (`ChannelList.vue` update):**
- Add `{ key: 'zalo', title: ..., description: ..., icon: 'i-woot-zalo' or fallback }`
- Translation keys trong `en.json`

**`Zalo.vue` component:**
- States UI:
  1. **Initial** — button "Start Login" (start_login API call)
  2. **Loading** — spinner "Generating QR code..."
  3. **QR displayed** — show base64 QR + text "Scan with Zalo app" + countdown timer (120s)
  4. **Scanning** — "QR scanned, confirm on phone..."
  5. **Confirming/Ready** — "Login successful, creating inbox..."
  6. **Expired** — "QR expired, try again" + Retry button
  7. **Error** — show error message + retry button

- Countdown timer: show "Expires in Xs", disable UI khi < 5s
- Poll `GET /login/:session_id` every 1.5s while status in [pending, qr_ready, scanning, confirmed]
- Stop polling on [ready, expired, failed]
- Auto-regenerate QR if status becomes `expired` (start new session automatically or show button)
- On `ready` → trigger `createChannel` via store dispatch → redirect

**Channel creation flow:**
- Option A (chosen): **Implicit** — Node POST to Rails internal → Channel+Inbox created → frontend detect "ready" + inbox_id → redirect
- Frontend poll receives `{ status: 'ready', inbox_id: 42 }` → redirect to `settings_inboxes_add_agents` với inbox_id

**`ChannelFactory.vue` update:**
- Add dispatch case for `sub_page === 'zalo'` → render `Zalo.vue`

### Non-Functional
- Use Composition API + `<script setup>`
- Use `useMapGetter`, `useStore` composables
- Tailwind only, no custom CSS
- Mobile responsive (QR code max-width 300px, centered)
- Accessibility: alt text on QR image, aria-live for status updates

## Architecture

### State machine (frontend)

```
┌────────┐  click Start  ┌──────────┐  API: start  ┌────────┐
│ idle   │──────────────►│ starting │─────────────►│ polling│
└────────┘               └──────────┘              └────┬───┘
                              │ error                   │
                              ▼                         │
                         ┌────────┐                     │
                         │ error  │◄────────────────────┤ status=failed
                         └────────┘                     │
                                                        │ status=qr_ready
                                                        ▼
                                              ┌────────────────┐
                                              │ show_qr        │
                                              │ + countdown    │
                                              └────┬───────────┘
                                                   │
                                 ┌─────────────────┼────────────────┐
                                 │ status=scanning │ status=expired │
                                 ▼                 │                ▼
                           ┌───────────┐           │          ┌──────────┐
                           │ scanning  │           │          │ expired  │
                           └─────┬─────┘           │          └────┬─────┘
                                 │ status=ready    │               │ retry
                                 ▼                 │               ▼
                           ┌───────────┐           │          ┌──────────┐
                           │ creating  │           │          │ starting │
                           │  _inbox   │           │          └──────────┘
                           └─────┬─────┘           │
                                 │                 │
                                 ▼                 │
                           ┌───────────┐           │
                           │ redirect  │           │
                           │ to agents │           │
                           └───────────┘           │
                                                   │
                                         (timeout 120s or API error)
```

### Files

```
app/javascript/dashboard/
├── routes/dashboard/settings/inbox/
│   ├── ChannelList.vue                 # MODIFY: add Zalo card
│   ├── ChannelFactory.vue              # MODIFY: add Zalo dispatch
│   └── channels/
│       └── Zalo.vue                    # NEW: main Zalo setup component
├── components/channels/zalo/           # NEW dir
│   ├── ZaloQrDisplay.vue               # QR image + countdown UI
│   ├── ZaloLoginStatus.vue             # status text + progress
│   └── ZaloRetryButton.vue             # reusable retry
├── api/inboxes.js                      # MODIFY: add zaloLogin, zaloLoginStatus methods
├── store/modules/inboxes.js            # MODIFY: add startZaloLogin action, pollZaloStatus action
└── i18n/locale/en/inboxMgmt.json       # MODIFY: add ZALO_CHANNEL keys
```

## Related Code Files

### To create
- `app/javascript/dashboard/routes/dashboard/settings/inbox/channels/Zalo.vue`
- `app/javascript/dashboard/components/channels/zalo/ZaloQrDisplay.vue`
- `app/javascript/dashboard/components/channels/zalo/ZaloLoginStatus.vue`
- `app/javascript/dashboard/components/channels/zalo/ZaloProxySelector.vue` — dropdown pick proxy from pool in QR flow
- `app/javascript/dashboard/routes/dashboard/settings/zalo-proxies/Index.vue` — list page
- `app/javascript/dashboard/routes/dashboard/settings/zalo-proxies/ProxyForm.vue` — create/edit modal
- `app/javascript/dashboard/components/layout/ZaloReconnectBanner.vue` — dashboard shell banner (persistent)
- `app/javascript/dashboard/api/zaloProxies.js` — CRUD API
- `app/javascript/dashboard/store/modules/zaloProxies.js` — Vuex module

### To modify
- `app/javascript/dashboard/routes/dashboard/settings/inbox/ChannelList.vue` — add Zalo card in `channelList` computed
- `app/javascript/dashboard/routes/dashboard/settings/inbox/ChannelFactory.vue` — add dispatch
- `app/javascript/dashboard/api/inboxes.js` — add `startZaloLogin`, `getZaloLoginStatus`, `deleteZaloSession` methods
- `app/javascript/dashboard/routes/settings.js` — add route for `settings/zalo-proxies`
- `app/javascript/dashboard/components/layout/Sidebar.vue` (or settings nav) — add "Zalo Proxies" entry
- `app/javascript/dashboard/components/layout/AppContainer.vue` (or equivalent dashboard shell) — mount ZaloReconnectBanner
- `app/javascript/dashboard/store/index.js` — register zaloProxies module
- `config/locales/en.json` — add `INBOX_MGMT.ADD.AUTH.CHANNEL.ZALO.*` + `INBOX_MGMT.ADD.ZALO_CHANNEL.*` + `SETTINGS.ZALO_PROXIES.*` + `ZALO.RECONNECT_BANNER.*` keys

### Reference (read-only)
- `app/javascript/dashboard/routes/dashboard/settings/inbox/channels/Telegram.vue` — pattern for createChannel + router.replace
- `app/javascript/dashboard/routes/dashboard/settings/inbox/channels/Api.vue` — pattern for API-type flow
- `app/javascript/dashboard/api/inboxes.js` — existing API pattern

## Implementation Steps

1. **API layer** (`api/inboxes.js`)
   ```js
   startZaloLogin() {
     return axios.post(`${this.url}/channels/zalo/login`);
   }
   getZaloLoginStatus(sessionId) {
     return axios.get(`${this.url}/channels/zalo/login/${sessionId}`);
   }
   deleteZaloSession(sessionId) {
     return axios.delete(`${this.url}/channels/zalo/${sessionId}`);
   }
   ```

2. **`Zalo.vue`** — main component
   ```vue
   <script setup>
   import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
   import { useI18n } from 'vue-i18n';
   import { useRouter } from 'vue-router';
   import { useStore } from 'dashboard/composables/store';
   import { useAlert } from 'dashboard/composables';
   import InboxesAPI from 'dashboard/api/inboxes';
   import PageHeader from '../SettingsSubPageHeader.vue';
   import ZaloQrDisplay from 'dashboard/components/channels/zalo/ZaloQrDisplay.vue';
   import ZaloLoginStatus from 'dashboard/components/channels/zalo/ZaloLoginStatus.vue';
   import NextButton from 'dashboard/components-next/button/Button.vue';
   
   const { t } = useI18n();
   const router = useRouter();
   
   // State
   const state = ref('idle'); // idle, starting, polling, show_qr, scanning, creating, error, expired
   const sessionId = ref(null);
   const qrBase64 = ref(null);
   const qrExpiresAt = ref(null);
   const errorMessage = ref(null);
   const pollTimer = ref(null);
   const countdownTimer = ref(null);
   const remainingSeconds = ref(0);
   
   const canRetry = computed(() => ['error', 'expired'].includes(state.value));
   
   const startLogin = async () => {
     state.value = 'starting';
     errorMessage.value = null;
     try {
       const { data } = await InboxesAPI.startZaloLogin();
       sessionId.value = data.session_id;
       state.value = 'polling';
       pollStatus();
     } catch (e) {
       setError(e.message || t('INBOX_MGMT.ADD.ZALO_CHANNEL.ERRORS.START_FAILED'));
     }
   };
   
   const pollStatus = () => {
     stopPoll();
     pollTimer.value = setInterval(fetchStatus, 1500);
     fetchStatus(); // immediate first call
   };
   
   const fetchStatus = async () => {
     try {
       const { data } = await InboxesAPI.getZaloLoginStatus(sessionId.value);
       applyStatus(data);
     } catch (e) {
       setError(t('INBOX_MGMT.ADD.ZALO_CHANNEL.ERRORS.POLL_FAILED'));
     }
   };
   
   const applyStatus = (data) => {
     switch (data.status) {
       case 'pending':
         state.value = 'polling';
         break;
       case 'qr_ready':
         state.value = 'show_qr';
         qrBase64.value = data.qr_base64;
         qrExpiresAt.value = Date.now() + 120_000;
         startCountdown();
         break;
       case 'scanning':
         state.value = 'scanning';
         stopCountdown();
         break;
       case 'confirmed':
       case 'ready':
         state.value = 'creating';
         stopPoll();
         stopCountdown();
         if (data.inbox_id) {
           redirectToAgents(data.inbox_id);
         }
         break;
       case 'expired':
         state.value = 'expired';
         stopPoll();
         stopCountdown();
         break;
       case 'failed':
         setError(data.error || t('INBOX_MGMT.ADD.ZALO_CHANNEL.ERRORS.LOGIN_FAILED'));
         break;
     }
   };
   
   const startCountdown = () => {
     stopCountdown();
     const tick = () => {
       remainingSeconds.value = Math.max(0, Math.ceil((qrExpiresAt.value - Date.now()) / 1000));
       if (remainingSeconds.value <= 0) {
         state.value = 'expired';
         stopPoll();
         stopCountdown();
       }
     };
     tick();
     countdownTimer.value = setInterval(tick, 1000);
   };
   
   const stopPoll = () => {
     if (pollTimer.value) clearInterval(pollTimer.value);
     pollTimer.value = null;
   };
   
   const stopCountdown = () => {
     if (countdownTimer.value) clearInterval(countdownTimer.value);
     countdownTimer.value = null;
   };
   
   const setError = (msg) => {
     state.value = 'error';
     errorMessage.value = msg;
     stopPoll();
     stopCountdown();
     useAlert(msg);
   };
   
   const redirectToAgents = (inboxId) => {
     router.replace({
       name: 'settings_inboxes_add_agents',
       params: { page: 'new', inbox_id: inboxId },
     });
   };
   
   const retry = () => {
     sessionId.value = null;
     qrBase64.value = null;
     errorMessage.value = null;
     startLogin();
   };
   
   onBeforeUnmount(() => {
     stopPoll();
     stopCountdown();
   });
   </script>
   
   <template>
     <div class="h-full w-full p-6 col-span-6">
       <PageHeader
         :header-title="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.TITLE')"
         :header-content="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.DESC')"
       />
       
       <!-- TOS warning banner -->
       <div class="bg-yellow-50 border border-yellow-300 rounded p-4 mb-6 text-sm text-yellow-800">
         <strong>{{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.WARNING_TITLE') }}</strong>
         <p>{{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.WARNING_BODY') }}</p>
       </div>
       
       <div v-if="state === 'idle'">
         <NextButton
           :label="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.START_BUTTON')"
           solid
           blue
           @click="startLogin"
         />
       </div>
       
       <div v-else-if="state === 'starting' || state === 'polling'" class="flex flex-col items-center gap-4">
         <spinner />
         <p>{{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.GENERATING_QR') }}</p>
       </div>
       
       <div v-else-if="state === 'show_qr'" class="flex flex-col items-center gap-4">
         <ZaloQrDisplay :qr-base64="qrBase64" :remaining-seconds="remainingSeconds" />
         <ZaloLoginStatus :state="state" />
       </div>
       
       <div v-else-if="state === 'scanning' || state === 'creating'" class="flex flex-col items-center gap-4">
         <spinner />
         <ZaloLoginStatus :state="state" />
       </div>
       
       <div v-else-if="state === 'expired'" class="flex flex-col items-center gap-4">
         <p class="text-red-600">{{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.EXPIRED') }}</p>
         <NextButton :label="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.RETRY')" @click="retry" />
       </div>
       
       <div v-else-if="state === 'error'" class="flex flex-col items-center gap-4">
         <p class="text-red-600">{{ errorMessage }}</p>
         <NextButton :label="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.RETRY')" @click="retry" />
       </div>
     </div>
   </template>
   ```

3. **`ZaloQrDisplay.vue`** — display QR image + countdown
   ```vue
   <script setup>
   defineProps({
     qrBase64: String,
     remainingSeconds: Number,
   });
   </script>
   <template>
     <div class="flex flex-col items-center gap-2">
       <img
         :src="`data:image/png;base64,${qrBase64}`"
         :alt="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.QR_ALT')"
         class="w-64 h-64 border border-gray-200 rounded p-2"
       />
       <p class="text-sm text-gray-500">
         {{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.EXPIRES_IN', { seconds: remainingSeconds }) }}
       </p>
     </div>
   </template>
   ```

4. **`ZaloLoginStatus.vue`** — status text translator
   ```vue
   <script setup>
   defineProps({ state: String });
   </script>
   <template>
     <p class="text-center" aria-live="polite">
       <template v-if="state === 'show_qr'">{{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.STATUS_SCAN') }}</template>
       <template v-else-if="state === 'scanning'">{{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.STATUS_SCANNING') }}</template>
       <template v-else-if="state === 'creating'">{{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.STATUS_CREATING') }}</template>
     </p>
   </template>
   ```

5. **Update `ChannelList.vue`**
   - Add sau `instagram`:
     ```js
     {
       key: 'zalo',
       title: t('INBOX_MGMT.ADD.AUTH.CHANNEL.ZALO.TITLE'),
       description: t('INBOX_MGMT.ADD.AUTH.CHANNEL.ZALO.DESCRIPTION'),
       icon: 'i-lucide-message-circle',  // fallback; custom icon optional
     },
     ```

6. **Update `ChannelFactory.vue`** — import Zalo.vue, add case `zalo` in dispatch

7. **i18n keys** (`config/locales/en.json`)
   ```json
   {
     "INBOX_MGMT": {
       "ADD": {
         "AUTH": {
           "CHANNEL": {
             "ZALO": {
               "TITLE": "Zalo",
               "DESCRIPTION": "Connect a Zalo personal account."
             }
           }
         },
         "ZALO_CHANNEL": {
           "TITLE": "Create Zalo Channel",
           "DESC": "Scan the QR code with your Zalo mobile app to connect.",
           "WARNING_TITLE": "Unofficial Zalo integration",
           "WARNING_BODY": "Using personal Zalo accounts is against Zalo's Terms of Service. Your account may be banned. Use at your own risk.",
           "START_BUTTON": "Start Login",
           "GENERATING_QR": "Generating QR code...",
           "QR_ALT": "Zalo login QR code",
           "EXPIRES_IN": "Expires in {seconds}s",
           "STATUS_SCAN": "Scan the QR code with Zalo mobile app",
           "STATUS_SCANNING": "QR code scanned. Confirm on your phone...",
           "STATUS_CREATING": "Login successful. Creating inbox...",
           "EXPIRED": "QR code expired. Try again.",
           "RETRY": "Retry",
           "ERRORS": {
             "START_FAILED": "Failed to start Zalo login. Please try again.",
             "POLL_FAILED": "Lost connection to Zalo service.",
             "LOGIN_FAILED": "Zalo login failed."
           }
         }
       }
     }
   }
   ```

8. **Manual UI test:**
   - Start all services
   - Settings → Inboxes → Add → Zalo card visible
   - Click → QR shown
   - Scan with test Zalo account → see state transitions
   - Redirect to add agents page

## Todo List

### QR login flow
- [ ] Update `api/inboxes.js` with 3 new methods
- [ ] Create `Zalo.vue` main component
- [ ] Create `ZaloQrDisplay.vue`
- [ ] Create `ZaloLoginStatus.vue`
- [ ] Create `ZaloProxySelector.vue` (fetch proxy pool, dropdown select)
- [ ] Update `ChannelList.vue` — add Zalo card
- [ ] Update `ChannelFactory.vue` — add dispatch

### Proxy management (UI v1)
- [ ] Create `zaloProxies.js` API wrapper (list, create, update, delete, test)
- [ ] Create `zaloProxies.js` Vuex module
- [ ] Create `settings/zalo-proxies/Index.vue` — table với status badges + "Test connection" button
- [ ] Create `settings/zalo-proxies/ProxyForm.vue` — form fields (name, scheme, host, port, username, password)
- [ ] Add settings route + sidebar nav entry
- [ ] Validation: URL parsing, port range, scheme enum

### Reconnect banner
- [ ] Create `ZaloReconnectBanner.vue` — subscribes account ActionCable channel
- [ ] On `zalo.session.disconnected` event → show red banner with inbox name + "Reconnect" button
- [ ] Click Reconnect → navigate to relogin flow
- [ ] Dismissible per-session (localStorage), but reappears on next event
- [ ] Mount in dashboard shell (global, visible on all pages)

### Group chat UI (v1)
- [ ] Add "Group" icon/label for conversations where `additional_attributes.zalo_thread_type === 1`
- [ ] Member list display in conversation details sidebar
- [ ] i18n strings

### i18n
- [ ] Add all keys to `en.json`
- [ ] Run `bin/sync_i18n_file_change`

### Testing
- [ ] Visual check all states: idle, loading, qr, scanning, expired, error
- [ ] Accessibility check (keyboard nav, aria-live, focus trap in modal)
- [ ] Mobile responsive check
- [ ] Manual E2E test with real Zalo account + proxy
- [ ] Vitest unit test cho Zalo.vue, ProxyForm.vue, ReconnectBanner.vue

## Success Criteria

1. Channel card Zalo hiện trong danh sách
2. Click vào Zalo → redirect đến Zalo.vue
3. Click Start Login → QR hiện trong ~3s
4. Scan QR bằng Zalo mobile → UI update theo state
5. Login success → redirect `settings_inboxes_add_agents` với inbox_id correct
6. QR expire → hiện nút retry → click → QR mới
7. Node service down → hiện error message + retry
8. i18n keys complete, không có missing key warning
9. Warning banner về TOS visible

## Risk Assessment

| Risk | Mitigation |
|---|---|
| QR base64 quá lớn (> 100KB) slow paint | Ensure Node compress QR (256x256 is enough) |
| Polling interval quá nhanh stress Rails | 1.5s interval, cache QR ở Rails (Phase 04) |
| User close tab giữa chừng → orphan session | Cleanup job at Phase 06 delete expired sessions |
| Route conflict với existing channel routes | Prefix `/channels/zalo/*` mới, không đụng |
| Translations miss | Chạy `bin/sync_i18n_file_change` để verify |

## Security Considerations

- QR base64 chỉ hiện trên trang, không lưu localStorage
- Session ID không secret nhưng short-lived
- Banner warning rõ ràng về TOS risk

## Next Steps

→ **Phase 06**: Logout detection, reconnect flow, session health monitor, notification system
