<script setup lang="ts">
import { ref, nextTick, watch } from 'vue';
import type { UseWebSocket, WsMessage } from '../api/websocket.js';

const props = defineProps<{
  ws: UseWebSocket;
}>();

interface ChatMessage {
  author: string;
  text: string;
  source: 'human' | 'agent';
  timestamp: string;
}

const messages = ref<ChatMessage[]>([]);
const input = ref('');
const messagesEl = ref<HTMLElement>();

// Listen for chat messages from server
props.ws.onMessage((msg: WsMessage) => {
  if (msg.type !== 'event') return;
  const data = msg.data as Record<string, unknown>;
  const payload = data.payload as Record<string, unknown> | undefined;
  if (!payload) return;
  if (payload.author === undefined || payload.text === undefined) return;
  // This is a chat.message record
  if (payload.source !== 'human' && payload.source !== 'agent') return;

  messages.value.push({
    author: payload.author as string,
    text: payload.text as string,
    source: payload.source as 'human' | 'agent',
    timestamp: payload.timestamp as string,
  });

  nextTick(() => {
    messagesEl.value?.scrollTo(0, messagesEl.value.scrollHeight);
  });
});

function send() {
  const text = input.value.trim();
  if (!text) return;

  props.ws.send({
    type: 'chat',
    author: 'Human',
    authorId: 'browser',
    text,
  });

  // Optimistically add to local list
  messages.value.push({
    author: 'Human',
    text,
    source: 'human',
    timestamp: new Date().toISOString(),
  });

  input.value = '';
  nextTick(() => {
    messagesEl.value?.scrollTo(0, messagesEl.value.scrollHeight);
  });
}
</script>

<template>
  <div class="chat">
    <div class="chat-header">Chat</div>
    <div ref="messagesEl" class="chat-messages">
      <div
        v-for="(msg, i) in messages"
        :key="i"
        class="chat-msg"
        :class="msg.source"
      >
        <span class="chat-author">{{ msg.author }}</span>
        <span class="chat-text">{{ msg.text }}</span>
      </div>
      <div v-if="messages.length === 0" class="chat-empty">
        No messages yet. Chat with the agent here.
      </div>
    </div>
    <div class="chat-input">
      <input
        v-model="input"
        placeholder="Type a message..."
        @keydown.enter="send"
      />
      <button @click="send" :disabled="!input.trim()">Send</button>
    </div>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-left: 1px solid #e0e0e0;
  background: #fafafa;
}

.chat-header {
  padding: 8px 12px;
  font-weight: 600;
  font-size: 13px;
  border-bottom: 1px solid #e0e0e0;
  background: #f0f0f0;
  color: #444;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chat-msg {
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.4;
  max-width: 90%;
}

.chat-msg.human {
  align-self: flex-end;
  background: #d4e5ff;
}

.chat-msg.agent {
  align-self: flex-start;
  background: #e8e8e8;
}

.chat-author {
  font-weight: 600;
  margin-right: 6px;
  font-size: 11px;
  opacity: 0.7;
}

.chat-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-empty {
  color: #999;
  font-size: 13px;
  text-align: center;
  padding: 20px;
}

.chat-input {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid #e0e0e0;
  background: #f5f5f5;
}

.chat-input input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}

.chat-input input:focus {
  border-color: #4a9eff;
}

.chat-input button {
  padding: 6px 14px;
  background: #4a9eff;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}

.chat-input button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
