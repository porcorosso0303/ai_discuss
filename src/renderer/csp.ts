import type { Plugin } from 'vite'

const hmrOriginPlaceholder = '__RENDERER_HMR_ORIGIN__'
const hmrOrigin = 'ws://localhost:5173'

export function transformRendererCsp(html: string, isDevelopment: boolean): string {
  return html.replace(hmrOriginPlaceholder, isDevelopment ? ` ${hmrOrigin}` : '')
}

export function createRendererCspPlugin(isDevelopment: boolean): Plugin {
  return {
    name: 'ai-debates-renderer-csp',
    transformIndexHtml: (html) => transformRendererCsp(html, isDevelopment)
  }
}
