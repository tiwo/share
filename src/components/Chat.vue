<script setup lang="ts">
import { defineProps, defineEmits, computed } from 'vue'

const props = defineProps<{ messages: any[]; selfId: string; isAuthenticated: boolean }>()
const emit = defineEmits<{
  (e: 'send-message', payload: { text: string }): void
}>()

import { ref } from 'vue'

const formatted = computed(() => props.messages.map((m) => ({ ...m })))
const message = ref('')

const onSend = () => {
  const text = message.value.trim()
  if (!text || !props.isAuthenticated) return
  emit('send-message', { text })
  message.value = ''
}
</script>

<template>
  <div class="panel chat-panel">
    <h2>Chat</h2>
    <div class="chat-window" style="max-height:220px;overflow:auto;padding:8px;border:1px solid #eee;margin-bottom:8px;">
      <div v-if="formatted.length === 0" class="hint-text">No messages yet.</div>
      <div v-for="msg in formatted" :key="msg.id" style="margin-bottom:6px;">
        <div style="font-size:12px;color:#666">{{ msg.from }} · {{ new Date(msg.ts).toLocaleTimeString() }}</div>
        <div style="padding:6px;background:#f7f7f8;border-radius:6px;display:inline-block">{{ msg.text }}</div>
      </div>
    </div>

    <div class="chat-controls" style="display:flex;gap:8px;">
      <input v-model="message" :disabled="!props.isAuthenticated" placeholder="Type a message" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;" @keyup.enter="onSend" />
      <button class="button" :disabled="!props.isAuthenticated" @click="onSend">Send</button>
    </div>

    <div style="margin-top:8px;color:#888;font-size:12px">Drag & drop files here to attach (coming soon)</div>
  </div>
</template>
