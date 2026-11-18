import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    server: {
      deps: {
        // node:sqlite predates this vitest version's builtin list; keep it external so
        // it is loaded by Node instead of resolved by vite.
        external: [/node:sqlite/]
      }
    }
  }
})