<script setup lang="ts">
import { defineProps, defineEmits, computed } from 'vue'

const props = defineProps<{ messages: any[]; selfId: string; isAuthenticated: boolean }>()
const emit = defineEmits<{
  (e: 'send-message', payload: { text: string }): void
  (e: 'send-file', payload: { file: File }): void
}>()

import { ref } from 'vue'

const formatted = computed(() => props.messages.map((m) => ({ ...m })))
const message = ref('')
const dragging = ref(false)

const onDrop = (ev: DragEvent) => {
  ev.preventDefault()
  dragging.value = false
  const files = ev.dataTransfer?.files
  if (!files || files.length === 0) return
  const file = files[0]
  if (!file) return
  if (!props.isAuthenticated) return
  emit('send-file', { file })
}

const onDragOver = (ev: DragEvent) => {
  ev.preventDefault()
}

const onDragEnter = () => (dragging.value = true)
const onDragLeave = () => (dragging.value = false)

const onSend = () => {
  const text = message.value.trim()
  if (!text || !props.isAuthenticated) return
  emit('send-message', { text })
  message.value = ''
}
</script>

<template>
  <div class="panel chat-panel" @drop.prevent="onDrop" @dragover.prevent="onDragOver" @dragenter.prevent="onDragEnter" @dragleave.prevent="onDragLeave" :style="dragging ? 'background:#f0f8ff' : ''">
    <h2>Chat</h2>
    <div class="chat-window" style="max-height:220px;overflow:auto;padding:8px;border:1px solid #eee;margin-bottom:8px;">
      <div v-if="formatted.length === 0" class="hint-text">No messages yet.</div>
      <div v-for="msg in formatted" :key="msg.id" style="margin-bottom:6px;">
        <div style="font-size:12px;color:#666">{{ msg.from }} · {{ new Date(msg.ts).toLocaleTimeString() }}</div>
        <div style="padding:6px;background:#f7f7f8;border-radius:6px;display:inline-block">
          <template v-if="msg.meta && msg.meta.attachment">
            <div>{{ msg.meta.attachment.name }} ({{ msg.meta.attachment.size }} bytes)</div>
            <div v-if="msg.meta.attachment.blobUrl">
              <a :href="msg.meta.attachment.blobUrl" target="_blank" rel="noreferrer">Download</a>
            </div>
            <div v-else>
              <small>Receiving... {{ Math.round((msg.meta.receivedBytes || 0) / (msg.meta.attachment.size || 1) * 100) }}%</small>
            </div>
          </template>
          <template v-else>
            {{ msg.text }}
          </template>
        </div>
      </div>
    </div>

    <div class="chat-controls" style="display:flex;gap:8px;">
      <input v-model="message" :disabled="!props.isAuthenticated" placeholder="Type a message" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;" @keyup.enter="onSend" />
      <button class="button" :disabled="!props.isAuthenticated" @click="onSend">Send</button>
    </div>

    <div style="margin-top:8px;color:#888;font-size:12px">Drag & drop files here to attach (coming soon)</div>
  </div>
</template>
