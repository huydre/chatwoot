<script setup>
defineProps({
  state: { type: String, required: true },
});
</script>

<template>
  <p class="text-center text-sm" aria-live="polite">
    <template v-if="state === 'show_qr'">
      {{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.STATUS_SCAN') }}
    </template>
    <template v-else-if="state === 'scanning'">
      {{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.STATUS_SCANNING') }}
    </template>
    <template v-else-if="state === 'creating' || state === 'confirmed'">
      {{ $t('INBOX_MGMT.ADD.ZALO_CHANNEL.STATUS_CREATING') }}
    </template>
  </p>
</template>
