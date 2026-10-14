import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // 本地开发把 /api 代理到后端 3001（部署后由 Nginx 按 /api/news/* 分流）
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  preview: {
    port: 4173,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } },
  },
  test: {
    // 只跑前端用例；后端用例用 node:test（cd server && npm test）
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
