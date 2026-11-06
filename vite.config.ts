import { defineConfig } from 'vite';

// Tauri expects a fixed port; TAURI_DEV_HOST is set when running on a phone/remote.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/target/**', '**/crates/**', '**/test-results/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WKWebView on macOS 11+ / WebView2 (Chromium) on Windows.
    target: ['safari15', 'chrome110'],
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
