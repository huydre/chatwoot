<script setup>
import { computed } from 'vue';

const props = defineProps({
  qrBase64: { type: String, required: true },
  remainingSeconds: { type: Number, default: 0 },
});

const src = computed(() =>
  props.qrBase64.startsWith('data:')
    ? props.qrBase64
    : `data:image/png;base64,${props.qrBase64}`
);
</script>

<template>
  <div class="flex flex-col items-center gap-3">
    <img
      :src="src"
      :alt="$t('INBOX_MGMT.ADD.ZALO_CHANNEL.QR_ALT')"
      class="w-64 h-64 border border-slate-200 rounded-lg p-2 bg-white"
    />
    <p class="text-sm text-slate-500">
      {{
        $t('INBOX_MGMT.ADD.ZALO_CHANNEL.EXPIRES_IN', {
          seconds: remainingSeconds,
        })
      }}
    </p>
  </div>
</template>
