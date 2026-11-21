<template>
  <div class="header">
    <div class="header-left">
      <img class="logo" src="@renderer/assets/images/icons/logo.png" alt="logo" />
    </div>
    <div class="header-right">
      <div class="language-switch">
        <span
          class="language-switch__item"
          :class="{ 'language-active': home.homeState.language === 'zh' }"
          @click="action.changeLanguage('zh')"
          >{{ $t('common.header.languageZhText') }}</span
        >
        <span class="language-switch__divider">/</span>
        <span
          class="language-switch__item"
          :class="{ 'language-active': home.homeState.language === 'en' }"
          @click="action.changeLanguage('en')"
          >{{ $t('common.header.languageEnText') }}</span
        >
      </div>
      <t-dropdown
        v-if="state.username || isDesktop"
        :maxColumnWidth="false"
        :min-column-width="120"
        placement="bottom-right"
        @click="action.clickHandler"
      >
        <div v-if="state.username" class="header-right-item header-avatar">
          <t-avatar class="header-avatar__img" :alt="state.username">{{ avatarChar }}</t-avatar>
        </div>
        <div v-else class="header-right-item" style="width: 70px">
          <img src="@renderer/assets/images/icons/setting.svg" alt="setting" />
          <div class="header-right-item-text">{{ $t('common.setting.title') }}</div>
        </div>
        <t-dropdown-menu>
          <t-dropdown-item
            v-for="(item, index) in state.menuList"
            :key="index + 'menuList'"
            :value="item.value"
          >
            {{ t(item.key) }}
          </t-dropdown-item>
        </t-dropdown-menu>
      </t-dropdown>
      <div class="header-right-item" v-if="isDesktop" @click="action.minimize">
        <t-tooltip :content="$t('common.header.minimizeText')">
          <img src="@renderer/assets/images/icons/minimize.png" />
        </t-tooltip>
      </div>
      <div class="header-right-item" v-if="isDesktop" @click="action.maximize">
        <t-tooltip
          :content="
            state.isMaximized ? $t('common.header.restoreText') : $t('common.header.minimizeText')
          "
        >
          <img src="@renderer/assets/images/icons/maximize.png" />
        </t-tooltip>
      </div>
      <div class="header-right-item" v-if="isDesktop" @click="action.close">
        <t-tooltip :content="$t('common.header.closeText')">
          <img src="@renderer/assets/images/icons/close.png" />
        </t-tooltip>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, computed } from 'vue'
import { Client, isDesktop } from '@renderer/client'
import { useHomeStore } from '@renderer/stores/home.js'
import { useI18n } from 'vue-i18n'
import { saveContext } from '@renderer/api/index.js'
import { lang_ } from '@renderer/utils/const.js'
import { getUsername } from '@renderer/utils/auth.js'

const { locale, t } = useI18n()
const home = useHomeStore()
const state = reactive({
  isMaximized: false,
  username: getUsername(),
  menuList: [
    {
      key: 'common.setting.tab.userAgreementText',
      value: 'agreement'
    },
    {
      key: 'common.setting.tab.openLogText',
      value: 'openLog'
    }
  ]
})
const avatarChar = computed(() => (state.username ? state.username.slice(0, 1).toUpperCase() : ''))
const action = {
  init() {
    action.setIsMaximized()
  },
  async setIsMaximized() {
    if (!isDesktop) return
    state.isMaximized = await Client.app.isMaximized()
  },
  minimize() {
    Client.app.minimize()
  },
  maximize() {
    Client.app.maximize()
    action.setIsMaximized()
  },
  close() {
    Client.app.close()
  },
  changeLanguage(value) {
    if (value !== 'zh' && value !== 'en') return
    window.localStorage.setItem('language', value)
    locale.value = value
    home.setLanguage(value)
    saveContextAjax(value)
  },
  clickHandler({ value }) {
    if (value === 'agreement') {
      home.setAgreementVisible(true)
    } else if (value === 'openLog') {
      Client.app.openLog()
    }
  }
}
const saveContextAjax = async (lang) => {
  try {
    const res = await saveContext(lang_, lang)
    console.log(res)
  } catch (error) {
    console.log(error)
  }
}
</script>

<style lang="less" scoped>
.language-switch {
  -webkit-app-region: no-drag;
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  font-size: 12px;
  color: #000000;
  user-select: none;

  &__item {
    cursor: pointer;
    line-height: 14px;

    &:hover {
      color: #166aff;
    }
  }

  &__divider {
    margin: 0 4px;
    color: #c5c5c5;
  }

  .language-active {
    color: #166aff;
    font-weight: 500;
  }
}

.header-avatar {
  &__img {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    font-size: 14px;
  }
}

.header {
  width: 100%;
  height: 60px;
  padding: 12px 20px 12px 14px;
  display: flex;
  position: fixed;
  top: 0;
  left: 0;
  align-items: center;
  background-color: #fff;
  -webkit-app-region: drag;
  -webkit-user-select: none;
  z-index: 999;
  box-shadow: inset 0px -1px 0px 0px #f2f2f4;

  &-left {
    width: 100%;
    flex: 1;
    height: 100%;

    .logo {
      width: 110px;
      height: 36px;
    }
  }

  &-right {
    display: flex;
    align-items: center;
    gap: 8px;

    &-item {
      -webkit-app-region: no-drag;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;

      &:hover {
        background-color: #f2f2f4;
      }

      img {
        width: 20px;
        height: 20px;
      }

      &-text {
        font-family:
          PingFang SC,
          PingFang SC;
        font-weight: 400;
        font-size: 12px;
        color: #000000;
        line-height: 14px;
        text-align: left;
      }
    }
  }
}
</style>
