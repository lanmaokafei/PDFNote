import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    sourcemap: true,
    // 每次构建清空 dist：否则历史 assets 与测试素材会被 Tauri 整包嵌入，
    // 导致 app 体积无上限膨胀（曾因 public/test-large.pdf 达到 525MB）。
    emptyOutDir: true,
  },
})
