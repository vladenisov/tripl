import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { compression } from 'vite-plugin-compression2'
import path from 'path'
import zlib from 'node:zlib'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Pre-compress JS/CSS/SVG/JSON to .br files served via nginx brotli_static.
    // We don't ship gzip — nginx falls back to identity if a client doesn't
    // accept brotli, which is rare in practice (all evergreen browsers do).
    compression({
      // [algorithm, options] — build-time, so max brotli quality is fine.
      algorithms: [
        [
          'brotliCompress',
          {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
            },
          },
        ],
      ],
      include: [/\.(js|mjs|css|html|svg|json|wasm)$/],
      threshold: 1024,
      deleteOriginalAssets: false,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Split vendor chunks so initial load doesn't ship recharts to pages that
    // don't use it, and so upgrading a single dep doesn't bust the whole cache.
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return
          if (id.includes('/recharts/')) return 'charts-vendor'
          if (id.includes('/@tanstack/')) return 'tanstack-vendor'
          if (id.includes('/@radix-ui/')) return 'radix-vendor'
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router') ||
            id.includes('/scheduler/')
          ) {
            return 'react-vendor'
          }
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.ts',
    // Vitest's 5000ms default caps the whole test, including time Testing Library
    // spends inside `findBy*`/`waitFor` — so it has to stay comfortably above the
    // 5000ms `asyncUtilTimeout` set in test-setup.ts, or a slow wait dies as an
    // unhelpful "Test timed out" instead of surfacing what the DOM actually held.
    // Headroom for a loaded machine, not licence for genuinely slow tests.
    testTimeout: 15000,
  },
})
