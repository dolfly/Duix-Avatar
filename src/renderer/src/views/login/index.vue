<script setup>
import { reactive, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { setToken } from '@renderer/utils/auth.js'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()

const form = reactive({ username: '', password: '' })
const loading = ref(false)
const errorMessage = ref('')

async function submit() {
  if (!form.username.trim() || !form.password) {
    errorMessage.value = t('login.emptyFields')
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.trim(), password: form.password })
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || !body.token) {
      errorMessage.value = body.message || t('login.failed')
      return
    }
    setToken(body.token)
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
      ? route.query.redirect
      : '/home'
    router.replace(redirect)
  } catch (error) {
    errorMessage.value = t('login.failed')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <img class="logo" src="@renderer/assets/images/icons/logo.png" alt="logo" />
      </div>
      <div class="form-item">
        <span class="label">{{ $t('login.username') }}</span>
        <t-input v-model="form.username" :placeholder="$t('login.usernamePlaceholder')" autocomplete="username" />
      </div>
      <div class="form-item">
        <span class="label">{{ $t('login.password') }}</span>
        <t-input
          v-model="form.password"
          type="password"
          :placeholder="$t('login.passwordPlaceholder')"
          autocomplete="current-password"
          @keydown.enter.prevent="submit"
        />
      </div>
      <div v-if="errorMessage" class="login-error">{{ errorMessage }}</div>
      <t-button class="submit" theme="primary" :loading="loading" @click="submit">{{
        $t('login.submit')
      }}</t-button>
    </div>
  </div>
</template>

<style lang="less" scoped>
.login-page {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #f4f4f6;
}

.login-card {
  width: 400px;
  padding: 40px 32px;
  border-radius: 8px;
  background-color: #fff;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
}

.login-header {
  display: flex;
  justify-content: center;
  margin-bottom: 32px;

  .logo {
    width: 160px;
  }
}

.form-item {
  margin-bottom: 20px;

  .label {
    display: block;
    margin-bottom: 8px;
    font-size: 14px;
    color: #333;
  }
}

.login-error {
  margin-bottom: 16px;
  font-size: 13px;
  color: #e34d59;
}

.submit {
  width: 100%;
}
</style>
