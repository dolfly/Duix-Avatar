<template>
  <div class="list">
    <!-- 搜索框 -->
    <t-input class="list-search" v-model="state.search" :placeholder="$t('common.editView.searchSpeaker')"
      @change="action.searchList">
      <template #prefix-icon>
        <SearchIcon />
      </template>
    </t-input>
    <div class="list-box noscrollbar">
      <div class="list-box__item" v-for="speaker in state.speakerList" :speaker-id="speaker.id" :key="speaker.id"
        @click="action.selectSpeaker(speaker)" :class="{ '--active': select.speaker?.id == speaker.id }">
        <t-avatar class="avatar" :alt="speaker.name">{{ speaker.name.slice(0, 1) }}</t-avatar>
        <div class="name" :title="speaker.name">{{ speaker.name }}</div>
        <t-image class="btn" v-if="state.playingId !== speaker.id" :src="PlayIcon"
          @click="action.handlePlay(speaker)" />
        <t-image class="btn" v-else :src="PauseIcon" @click="action.handlePlay(speaker)" />
      </div>
    </div>
  </div>

</template>
<script setup>
import { reactive, onUnmounted, watchEffect } from 'vue'
import { SearchIcon } from 'tdesign-icons-vue-next'
import PlayIcon from '@renderer/assets/images/icons/icon-play.png'
import PauseIcon from '@renderer/assets/images/icons/icon-pause.png'
import { modelPage, voicePreview } from '@renderer/api'
import { isDesktop } from '@renderer/client'
import { localUrl } from '@renderer/utils'
import { MessagePlugin } from 'tdesign-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const select = defineModel({})

const AUDIO_STATUS = {
  UNPLAY: 0,
  PLAYING: 1,
  PLAYED: 2,
}

onUnmounted(() => {
  action.stopAudio()
})

const audio = new Audio()

audio.addEventListener('ended', () => {
  action.stopAudio()
})

const props = defineProps({
  popupVisible: {
    type: Boolean,
    default: false
  }
})

const state = reactive({
  search: '',
  playingId: '',
  status: AUDIO_STATUS.UNPLAY,
  speakerList: [],
  blobUrl: '',
  // Monotonic sequence for the in-flight play request. `stopAudio` and each new
  // play bump it, so a stale fetch that resolves late can detect it is no longer
  // current and drop itself without touching the active blob/audio.
  requestSeq: 0
})


const emit = defineEmits(['onSelect'])

const action = {
  init() {
    watchEffect(async () => {
      if (props.popupVisible) {
        await action.searchList()
        setTimeout(action.scrollToSelectSpeaker);
      } else {
        action.stopAudio()
      }
    })
  },
  async searchList() {
    try {
      const result = await modelPage({
        name: state.search,
        page: 1,
        pageSize: 100
      })
      state.speakerList = result.list || []
    } catch (err) {
      console.error('查询音色列表失败', err)
      state.speakerList = []
    }
  },
  // 选中的音色滚动到中间
  scrollToSelectSpeaker() {
    const speakerId = select.value.speaker?.id
    if (speakerId) {
      const target = document.querySelector(`div[speaker-id="${speakerId}"]`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  },
  selectSpeaker(speaker) {
    select.value.speaker = speaker
    emit('onSelect', speaker)
  },

  stopAudio() {
    // Invalidate any in-flight play request so its late resolution is discarded.
    state.requestSeq += 1
    audio.pause()
    audio.currentTime = 0
    state.playingId = ''
    if (state.blobUrl) {
      URL.revokeObjectURL(state.blobUrl)
      state.blobUrl = ''
    }
  },
  async playAudio(speaker) {
    // Claim the current request slot. A second click or a stop bumps the sequence
    // and makes this request stale.
    const seq = state.requestSeq + 1
    state.requestSeq = seq
    state.playingId = speaker.id
    try {
      // Desktop: absolute filesystem path → file:// URL (ipcApi stays untouched).
      // Web: the preview endpoint requires auth, so fetch it with the token and
      // play a blob URL (an <audio> tag cannot send the Authorization header).
      if (isDesktop) {
        audio.src = localUrl.addFileProtocol(speaker.audio_path)
      } else {
        const url = await voicePreview(speaker.audio_path)
        // Stale completion guard: a newer play/stop superseded this request. Drop
        // it and revoke only OUR blob — never the blob currently in use.
        if (seq !== state.requestSeq) {
          URL.revokeObjectURL(url)
          return
        }
        if (state.blobUrl) URL.revokeObjectURL(state.blobUrl)
        state.blobUrl = url
        audio.src = url
      }
      await audio.play()
    } catch (err) {
      // Only the still-current request reports errors; a superseded one already
      // returned above and must not flip the UI back.
      if (seq !== state.requestSeq) return
      const message = err && err.message
      action.stopAudio()
      if (message && /参考音频不存在|音色不存在|不存在/.test(message)) {
        MessagePlugin.error(t('common.editView.noReferenceAudio'))
      } else {
        MessagePlugin.error(t('common.editView.playAudioError'))
      }
    }
  },

  handlePlay(speaker) {
    action.selectSpeaker(speaker)
    if (!speaker.audio_path) {
      MessagePlugin.error(t('common.editView.noReferenceAudio'))
      return
    }
    // Toggle only when this voice is actually playing (not merely requested); a
    // pending fetch has `audio.paused` true, so a second click restarts it cleanly
    // instead of leaving sound playing under a play-state button.
    if (state.playingId === speaker.id && !audio.paused && !audio.ended) {
      action.stopAudio()
    } else {
      action.playAudio(speaker)
    }
  },
}

action.init()

</script>

<style lang="less" scoped>
.list {
  display: flex;
  flex-direction: column;
  overflow: hidden;

  &-search {
    flex: none;
    padding: 16px 12px;
    --td-bg-color-specialcomponent: #1d1e20;
    --td-text-color-primary: #ffffff;
    --td-text-color-placeholder: rgba(255, 255, 255, 0.6);

    :deep(.t-input) {
      border-color: rgba(255, 255, 255, 0.6);
    }

    :deep(.t-input--focused) {
      box-shadow: none;
    }
  }

  &-box {
    flex: 1;
    overflow: auto;
    padding: 0 12px;
  }

  &-box__item {
    width: 100%;
    height: 72px;
    background: #27292D;
    margin-bottom: 12px;
    border-radius: 4px 4px 4px 4px;
    border: 1px solid transparent;
    padding: 0px 20px;
    display: flex;
    align-items: center;
    gap: 8px;

    &.--active {
      border: 1px solid var(--td-brand-color);
    }

    &:last-of-type {
      margin-bottom: 21px;
    }

    .avatar {
      flex: none;
      width: 40px;
      height: 40px;
    }

    .name {
      font-weight: 500;
      font-size: 14px;
      color: #FFFFFF;
      line-height: 22px;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      /* 限制在两行 */
      overflow: hidden;
      /* 隐藏溢出的内容 */
      text-overflow: ellipsis;
      /* 溢出时显示省略号 */
    }

    .btn {
      flex: none;
      margin-left: auto;
      cursor: pointer;
      width: 28px;
      height: 28px;
      background: transparent;
    }
  }
}
</style>
