import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Vite's default port 5173 is shared with every other Vite project on the machine, and a
// browser keys service workers, HTTP cache, localStorage and IndexedDB by origin
// (scheme + host + port). Sharing a port therefore shares that origin with unrelated apps,
// so a service worker or cached bundle from another project's dev server can answer for
// this one. Keep this project on a dedicated port and fail loudly with strictPort instead
// of drifting to the next free port, which is how the collision happens in the first place.
const devPort = Number(process.env.VITE_PORT) || 5199

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset URLs are right in every place this app runs: GitHub Pages serves it from
  // a subfolder (`/ConvZal/`), and the desktop app loads dist/index.html over `file://`, where
  // an absolute base points at the drive root and the window comes up blank. An absolute base
  // is also what breaks a Pages site when the repository gets renamed, so the workflow no
  // longer sets one; VITE_BASE_PATH stays only as an escape hatch for special deployments.
  base: process.env.VITE_BASE_PATH || './',
  server: {
    port: devPort,
    strictPort: true,
  },
  preview: {
    port: devPort,
    strictPort: true,
  },
})
