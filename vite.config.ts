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
  // The Pages workflow sets an absolute base (`/Web_convert/`) and that is exactly right for
  // a site served from a subfolder. Everywhere else - most of all the desktop app, which
  // loads dist/index.html over `file://` - an absolute base points at the drive root and the
  // window comes up blank. Relative URLs resolve correctly in both places.
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
