import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { cpSync } from 'fs'

// Copies the standalone Prédicta pages and their shared JS into the
// build output so they're served at the same absolute paths
// (/predicta-*.html, /js/supabase-client.js) once deployed.
function copyPredictaAssets() {
  return {
    name: 'copy-predicta-assets',
    closeBundle() {
      cpSync('js', 'dist/js', { recursive: true })
    },
  }
}

export default defineConfig({
  plugins: [react(), copyPredictaAssets()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        predictaLanding: resolve(__dirname, 'predicta-landing.html'),
        predictaDashboard: resolve(__dirname, 'predicta-dashboard.html'),
        predictaAuth: resolve(__dirname, 'predicta-auth.html'),
      },
    },
  },
})
