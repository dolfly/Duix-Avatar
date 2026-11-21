/**
 * Browser-side auth token helpers.
 *
 * The web build stores the bearer token in localStorage. The Electron build never
 * needs these: the router guard is a no-op there and its api layer answers over IPC
 * instead of HTTP, so the desktop flow is unchanged.
 */

const TOKEN_KEY = 'duix.auth.token'
const USERNAME_KEY = 'duix.auth.username'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function getUsername() {
  return localStorage.getItem(USERNAME_KEY) || ''
}

export function setUsername(username) {
  if (username) localStorage.setItem(USERNAME_KEY, username)
  else localStorage.removeItem(USERNAME_KEY)
}

export function clearUsername() {
  localStorage.removeItem(USERNAME_KEY)
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export function isLoggedIn() {
  return Boolean(getToken())
}
