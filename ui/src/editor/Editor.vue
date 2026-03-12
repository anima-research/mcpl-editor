<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { EditorSync } from './sync.js';

const props = defineProps<{
  sync: EditorSync;
}>();

const editorEl = ref<HTMLElement>();

onMounted(() => {
  if (editorEl.value) {
    props.sync.setContainer(editorEl.value);
  }
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
