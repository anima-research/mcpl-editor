<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { useWebSocket } from './api/websocket.js';
import { createEditorSync } from './editor/sync.js';
import Editor from './editor/Editor.vue';
import Chat from './chat/Chat.vue';

const ws = useWebSocket();

const sync = createEditorSync(ws, [
  lineNumbers(),
  highlightActiveLine(),
  drawSelection(),
  highlightSelectionMatches(),
  history(),
  syntaxHighlighting(defaultHighlightStyle),
  markdown(),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
  EditorView.theme({
    '&': { height: '100%', fontSize: '14px' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    },
    '.cm-content': { padding: '16px 0' },
    '.cm-gutters': {
      backgroundColor: '#f8f9fa',
      borderRight: '1px solid #e0e0e0',
      color: '#999',
    },
    '.cm-activeLine': { backgroundColor: '#f0f4ff' },
  }),
]);

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
