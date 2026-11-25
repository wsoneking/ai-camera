import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// getUserMedia only works in a secure context. http://localhost qualifies, but
// opening the page from a phone over the LAN does not — `npm run dev:https`
// sets HTTPS=1 and serves a self-signed cert for that case.
const useHttps = process.env.HTTPS === '1';

export default defineConfig({
  plugins: useHttps ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    // The MediaPipe .task models and .wasm blobs are already compressed; never
    // inline them as base64.
    assetsInlineLimit: 0,
  },
});
