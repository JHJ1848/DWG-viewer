<template>
  <section>
    <button type="button" @click="engine?.fitToView()">居中</button>
    <span role="status">{{ status }}</span>
    <div ref="canvas" style="height: 65vh; position: relative; overflow: hidden"></div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { DwgViewerEngine } from './core/dwgViewerEngine';

const canvas = ref<HTMLElement | null>(null);
const status = ref('');
let engine: DwgViewerEngine | null = null;
let loading = false;

onMounted(() => {
  engine = new DwgViewerEngine({
    onProgress: p => { if (p.isLoading) status.value = p.stageTitle; },
    onLoaded: meta => { status.value = meta.fileName; },
    onError: message => { status.value = message; },
  });
  engine.mount(canvas.value!);
});

async function open(fileName: string, bytes: ArrayBuffer) {
  if (!engine || loading) throw new Error('视口未就绪或正在加载图纸');
  loading = true;
  try {
    return await engine.loadFromBuffer(fileName, bytes);
  } finally {
    loading = false;
  }
}

defineExpose({ open });
onBeforeUnmount(() => engine?.destroy());
</script>
