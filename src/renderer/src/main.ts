import './main.css'

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { port } from './index'

// Attach the per-run app token to every call to the local HUD server API.
// Without it the server rejects requests from the packaged app (Origin "null").
const apiOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`]
const nativeFetch = window.fetch.bind(window)
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (window.api?.appToken && apiOrigins.some((o) => url.startsWith(o))) {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    headers.set('x-jts-token', window.api.appToken)
    return nativeFetch(input, { ...init, headers })
  }
  return nativeFetch(input, init)
}

createApp(App).use(router).mount('#app')
