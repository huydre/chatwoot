<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAlert } from 'dashboard/composables';
import InboxesAPI from 'dashboard/api/inboxes';
import PageHeader from '../../SettingsSubPageHeader.vue';
import ZaloQrDisplay from 'dashboard/components/channels/zalo/ZaloQrDisplay.vue';
import ZaloLoginStatus from 'dashboard/components/channels/zalo/ZaloLoginStatus.vue';
import NextButton from 'dashboard/components-next/button/Button.vue';
import Spinner from 'shared/components/Spinner.vue';

const { t } = useI18n();
const router = useRouter();

/**
 * High-level state machine for the Zalo QR login UI. Polls the Rails QR
 * proxy every ~1.5s and reacts to state transitions pushed from the Node
 * sidecar via session-context serialization.
 *
 * States: idle → starting → polling → show_qr → scanning → creating → done
 * Terminal failures land on 'expired' or 'error', both surfaced with a retry
 * button.
 */
const state = ref('idle');
const sessionId = ref(null);
const qrBase64 = ref(null);
const qrExpiresAt = ref(null);
const remainingSeconds = ref(0);
const errorMessage = ref(null);
const pollTimer = ref(null);
const countdownTimer = ref(null);

const POLL_INTERVAL_MS = 1500;
const QR_TTL_MS = 120_000;

const canRetry = computed(() => ['error', 'expired'].includes(state.value));
const showSpinner = computed(() =>
  ['starting', 'polling', 'scanning', 'creating', 'confirmed'].includes(
    state.value
  )
);

const clearTimers = () => {
  if (pollTimer.value) clearInterval(pollTimer.value);
  if (countdownTimer.value) clearInterval(countdownTimer.value);
  pollTimer.value = null;
  countdownTimer.value = null;
};

const setError = msg => {
  state.value = 'error';
  errorMessage.value = msg;
  clearTimers();
  useAlert(msg);
};

const startCountdown = () => {
  if (countdownTimer.value) clearInterval(countdownTimer.value);
  const tick = () => {
    remainingSeconds.value = Math.max(
      0,
      Math.ceil((qrExpiresAt.value - Date.now()) / 1000)
    );
    if (remainingSeconds.value <= 0) {
      state.value = 'expired';
      clearTimers();
    }
  };
  tick();
  countdownTimer.value = setInterval(tick, 1000);
};

const applyStatus = data => {
  const s = (data && data.status) || data.state;
  switch (s) {
    case 'pending':
      state.value = 'polling';
      break;
    case 'qr_ready':
      state.value = 'show_qr';
      qrBase64.value = data.qr_base64;
      qrExpiresAt.value = Date.now() + QR_TTL_MS;
      startCountdown();
      break;
    case 'scanning':
      state.value = 'scanning';
      break;
    case 'confirmed':
      state.value = 'confirmed';
      break;
    case 'ready': {
      state.value = 'creating';
      clearTimers();
      // The Rails controller should return inbox_id once the channel is
      // persisted. Until then we just land on a "success" message and let
      // the user navigate back — the inbox will appear in the list.
      if (data.inbox_id) {
        router.replace({
          name: 'settings_inboxes_add_agents',
          params: { page: 'new', inbox_id: data.inbox_id },
        });
      } else {
        useAlert(t('INBOX_MGMT.ADD.ZALO_CHANNEL.SUCCESS_NO_INBOX'));
        router.replace({ name: 'settings_inbox_list' });
      }
      break;
    }
    case 'expired':
      state.value = 'expired';
      clearTimers();
      break;
    case 'failed':
      setError(
        (data && data.error_message) ||
          t('INBOX_MGMT.ADD.ZALO_CHANNEL.ERRORS.LOGIN_FAILED')
      );
      break;
    default:
      // unknown status — keep polling
      break;
  }
};

const fetchStatus = async () => {
  try {
    const res = await InboxesAPI.getZaloLoginStatus(sessionId.value);
    applyStatus(res.data || {});
  } catch (err) {
    setError(
      err.response?.data?.error ||
        t('INBOX_MGMT.ADD.ZALO_CHANNEL.ERRORS.POLL_FAILED')
    );
  }
};

const startLogin = async () => {
  state.value = 'starting';
  errorMessage.value = null;
  try {
    const res = await InboxesAPI.startZaloLogin();
    sessionId.value = res.data.session_id;
    state.value = 'polling';
    // Kick off polling — first tick immediate, then every interval
    fetchStatus();
    pollTimer.value = setInterval(fetchStatus, POLL_INTERVAL_MS);
  } catch (err) {
    setError(
      err.response?.data?.error ||
        t('INBOX_MGMT.ADD.ZALO_CHANNEL.ERRORS.START_FAILED')
    );
  }
};

const retry = () => {
  sessionId.value = null;
  qrBase64.value = null;
  errorMessage.value = null;
  state.value = 'idle';
  startLogin();
};

onBeforeUnmount(() => {
  clearTimers();
});
</script>

<template>
  <div class="h-full w-full p-6 col-span-6">
    <PageHeader
      :header-title="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.TITLE')"
      :header-content="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.DESC')"
    />

    <!-- TOS warning banner -->
    <div
      class="bg-yellow-50 border border-yellow-300 rounded p-4 my-6 text-sm text-yellow-800"
    >
      <strong>{{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.WARNING_TITLE') }}</strong>
      <p class="mt-1">{{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.WARNING_BODY') }}</p>
    </div>

    <div v-if="state === 'idle'" class="flex flex-col items-center gap-4 py-6">
      <p class="text-sm text-slate-600 text-center max-w-md">
        {{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.INSTRUCTIONS') }}
      </p>
      <NextButton
        :label="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.START_BUTTON')"
        solid
        blue
        @click="startLogin"
      />
    </div>

    <div
      v-else-if="state === 'starting' || state === 'polling'"
      class="flex flex-col items-center gap-4 py-8"
    >
      <Spinner />
      <p>{{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.GENERATING_QR') }}</p>
    </div>

    <div
      v-else-if="state === 'show_qr'"
      class="flex flex-col items-center gap-4 py-6"
    >
      <ZaloQrDisplay
        :qr-base64="qrBase64"
        :remaining-seconds="remainingSeconds"
      />
      <ZaloLoginStatus :state="state" />
    </div>

    <div
      v-else-if="['scanning', 'confirmed', 'creating'].includes(state)"
      class="flex flex-col items-center gap-4 py-8"
    >
      <Spinner v-if="showSpinner" />
      <ZaloLoginStatus :state="state" />
    </div>

    <div
      v-else-if="state === 'expired'"
      class="flex flex-col items-center gap-4 py-8"
    >
      <p class="text-red-600">
        {{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.EXPIRED') }}
      </p>
      <NextButton
        :label="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.RETRY')"
        @click="retry"
      />
    </div>

    <div
      v-else-if="state === 'error'"
      class="flex flex-col items-center gap-4 py-8"
    >
      <p class="text-red-600 text-center max-w-md">{{ errorMessage }}</p>
      <NextButton
        v-if="canRetry"
        :label="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.RETRY')"
        @click="retry"
      />
    </div>
  </div>
</template>
