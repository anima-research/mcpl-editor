<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useWebSocket } from './api/websocket.js';
import { createEditorSync } from './editor/sync.js';
import Editor from './editor/Editor.vue';
import Chat from './chat/Chat.vue';

const ws = useWebSocket();
const sync = createEditorSync(ws);

// Route WS messages to editor sync
ws.onMessage((msg) => sync.handleMessage(msg));

onMounted(() => {
  ws.connect();
});

onUnmounted(() => {
  ws.disconnect();
});
</script>

<template>
  <div class="app">
    <div class="toolbar">
      <span class="title">mcpl-editor</span>
      <span class="status" :class="{ connected: ws.connected.value }">
        {{ ws.connected.value ? 'Connected' : 'Disconnected' }}
      </span>
      <span v-if="ws.clientId.value" class="client-id">{{ ws.clientId.value }}</span>
    </div>
    <div class="main">
      <div class="editor-pane">
        <Editor :sync="sync" />
      </div>
      <div class="chat-pane">
        <Chat :ws="ws" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  background: #1a1a2e;
  color: #ccc;
  font-size: 13px;
  flex-shrink: 0;
}

.title {
  font-weight: 700;
  color: #fff;
}

.status {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  background: #e74c3c;
  color: white;
}

.status.connected {
  background: #27ae60;
}

.client-id {
  opacity: 0.5;
  font-size: 11px;
  font-family: monospace;
}

.main {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.editor-pane {
  flex: 1;
  overflow: hidden;
}

.chat-pane {
  width: 320px;
  flex-shrink: 0;
}
</style>
