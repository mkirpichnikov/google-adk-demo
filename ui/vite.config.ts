import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vite dev: proxy SSE + REST to FastAPI on :8080.
// Build output: ui/dist (served as static by FastAPI in prod).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/chat': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/healthz': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/sessions': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
})
