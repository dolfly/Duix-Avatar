import { createRouter, createWebHashHistory } from 'vue-router'
import home from '@renderer/views/home/index.vue'
import account from '@renderer/views/account/index.vue'
import VideoEditView from '@renderer/views/video-edit/VideoEditView.vue'
import login from '@renderer/views/login/index.vue'
import { isDesktop } from '@renderer/client'
import { isLoggedIn } from '@renderer/utils/auth.js'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'root',
      redirect: '/home'
    },
    {
      path: '/home',
      name: 'home',
      component: home
    },
    {
      path: '/video/edit',
      name: 'videoEdit',
      component: VideoEditView
    },
    {
      path: '/account',
      name: 'account',
      component: account
    },
    {
      path: '/login',
      name: 'login',
      component: login
    }
  ]
})

/**
 * Auth guard (web build only). The Electron build talks to the main process over IPC
 * and never reaches the HTTP auth layer, so the guard is a no-op there and the
 * original desktop flow is unchanged.
 */
router.beforeEach((to) => {
  if (isDesktop) return true
  if (to.name === 'login') {
    return isLoggedIn() ? { name: 'home' } : true
  }
  return isLoggedIn() ? true : { name: 'login', query: { redirect: to.fullPath } }
})

export default router
