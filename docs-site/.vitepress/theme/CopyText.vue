<script setup>
// 表格内联复制按钮：用于社区联系方式（QQ 群号、微信号）。
// 仅 navigator.clipboard 一条路径，失败时按钮短暂变 ✗ 提示手动复制。
import { ref } from "vue";

const props = defineProps({
  text: { type: String, required: true },
});

const state = ref("idle"); // idle | copied | failed

async function copy() {
  try {
    await navigator.clipboard.writeText(props.text);
    state.value = "copied";
  } catch {
    state.value = "failed";
  }
  setTimeout(() => {
    state.value = "idle";
  }, 1500);
}
</script>

<template>
  <button
    type="button"
    class="copy-text-btn"
    :class="{ copied: state === 'copied', failed: state === 'failed' }"
    :title="state === 'copied' ? '已复制' : '点击复制'"
    @click="copy"
  >
    {{ state === "copied" ? "✓" : state === "failed" ? "✗" : "⧉" }}
  </button>
</template>
