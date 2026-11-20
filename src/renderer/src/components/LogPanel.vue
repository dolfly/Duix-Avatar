<template>
  <t-dialog
    v-model:visible="visible"
    :header="$t('common.setting.logPanel.title')"
    :width="820"
    placement="center"
    :close-on-overlay-click="true"
    :close-on-esc-keydown="true"
  >
    <div class="log-panel">
      <div class="log-panel-toolbar">
        <span class="log-panel-total">{{ $t('common.setting.logPanel.total', { count: logs.length }) }}</span>
        <t-button size="small" variant="outline" theme="default" :loading="refreshing" @click="onRefresh">
          {{ $t('common.setting.logPanel.refresh') }}
        </t-button>
      </div>
      <div ref="listRef" class="log-panel-list">
        <div v-if="error" class="log-panel-empty">
          <p class="log-panel-empty-title">{{ $t('common.setting.logPanel.loadFailed') }}</p>
          <p class="log-panel-empty-detail">{{ error }}</p>
        </div>
        <div v-else-if="logs.length === 0" class="log-panel-empty">
          {{ $t('common.setting.logPanel.empty') }}
        </div>
        <template v-else>
          <div v-for="(item, index) in logs" :key="`${item.time}-${index}`" class="log-panel-item">
            <span class="log-panel-time">{{ formatTime(item.time) }}</span>
            <span class="log-panel-level" :class="`is-${item.level}`">{{ item.level }}</span>
            <span class="log-panel-message">{{ item.message }}</span>
          </div>
        </template>
      </div>
    </div>
    <template #footer>
      <t-button theme="primary" @click="close">{{ $t('common.setting.logPanel.close') }}</t-button>
    </template>
  </t-dialog>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { formatDate } from '@renderer/utils/index.js'
import { http } from '@renderer/api/index.js'

const OPEN_EVENT = 'duix:open-log-panel'
const REFRESH_INTERVAL = 5000

const visible = ref(false)
const logs = ref([])
const refreshing = ref(false)
const error = ref('')
const listRef = ref(null)

let timer = null

function formatTime(value) {
  return formatDate(value, 'YYYY-MM-DD HH:mm:ss')
}

async function refresh() {
  try {
    const data = await http('/api/logs?limit=200')
    logs.value = Array.isArray(data && data.list) ? data.list : []
    error.value = ''
    scrollToBottom()
  } catch (err) {
    error.value = (err && err.message) || String(err)
  }
}

async function onRefresh() {
  refreshing.value = true
  try {
    await refresh()
  } finally {
    refreshing.value = false
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
  })
}

function open() {
  visible.value = true
}

function close() {
  visible.value = false
}

function startPolling() {
  stopPolling()
  timer = window.setInterval(refresh, REFRESH_INTERVAL)
}

function stopPolling() {
  if (timer) {
    window.clearInterval(timer)
    timer = null
  }
}

onMounted(() => {
  window.addEventListener(OPEN_EVENT, open)
})

onUnmounted(() => {
  window.removeEventListener(OPEN_EVENT, open)
  stopPolling()
})

watch(visible, (value) => {
  if (value) {
    error.value = ''
    refresh()
    startPolling()
  } else {
    stopPolling()
    logs.value = []
    error.value = ''
  }
})
</script>

<style lang="less" scoped>
.log-panel {
  &-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  &-total {
    font-size: 12px;
    color: #696f7a;
  }

  &-list {
    height: 440px;
    overflow-y: auto;
    border: 1px solid #f2f2f4;
    border-radius: 4px;
    padding: 8px 12px;
    background-color: #fafafa;
  }

  &-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 4px 0;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 18px;
    border-bottom: 1px dashed #f2f2f4;

    &:last-child {
      border-bottom: none;
    }
  }

  &-time {
    flex-shrink: 0;
    color: #909399;
  }

  &-level {
    flex-shrink: 0;
    padding: 0 6px;
    border-radius: 2px;
    text-transform: uppercase;

    &.is-debug {
      color: #909399;
      background-color: rgba(144, 147, 153, 0.12);
    }

    &.is-info {
      color: #166aff;
      background-color: rgba(22, 106, 255, 0.1);
    }

    &.is-warn {
      color: #ed7b2f;
      background-color: rgba(237, 123, 47, 0.12);
    }

    &.is-error {
      color: #d54941;
      background-color: rgba(213, 73, 65, 0.12);
    }
  }

  &-message {
    color: #303133;
    word-break: break-all;
    white-space: pre-wrap;
  }

  &-empty {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #909399;
    font-size: 13px;

    &-title {
      color: #303133;
      font-weight: 500;
      margin-bottom: 8px;
    }

    &-detail {
      font-size: 12px;
      color: #d54941;
      word-break: break-all;
    }
  }
}
</style>
