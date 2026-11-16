import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: 'https://127.0.0.1:8443', secure: false, changeOrigin: true },
      '/p': { target: 'https://127.0.0.1:8443', secure: false, changeOrigin: true },
    },
  },
});
