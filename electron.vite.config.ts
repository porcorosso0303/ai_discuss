import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

import { createRendererCspPlugin } from './src/renderer/csp'

export default defineConfig(({ command }) => {
  const isDevelopment = command === 'serve'

  return {
    main: {},
    preload: {},
    renderer: {
      root: resolve('src/renderer'),
      server: {
        host: 'localhost',
        port: 5173,
        strictPort: true
      },
      plugins: [react(), createRendererCspPlugin(isDevelopment)]
    }
  }
})
