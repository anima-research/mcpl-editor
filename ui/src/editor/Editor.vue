<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import type { EditorSync } from './sync.js';

const props = defineProps<{
  sync: EditorSync;
}>();

const editorEl = ref<HTMLElement>();

onMounted(() => {
  if (!editorEl.value) return;

  const state = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      highlightSelectionMatches(),
      history(),
      syntaxHighlighting(defaultHighlightStyle),
      markdown(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      ...props.sync.extensions(),
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
    ],
  });

  const view = new EditorView({
    state,
    parent: editorEl.value,
  });

  onUnmounted(() => {
    view.destroy();
  });
});
</script>

<template>
  <div ref="editorEl" class="editor-container"></div>
</template>

<style scoped>
.editor-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.editor-container :deep(.cm-editor) {
  height: 100%;
}
</style>
