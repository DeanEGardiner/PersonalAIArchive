import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, path.resolve(__dirname, '..'), ''),
    ...loadEnv(mode, __dirname, '')
  };

  const backendPort = process.env.BACKEND_PORT || env.BACKEND_PORT || process.env.PORT || env.PORT || '3003';
  const backendTarget = process.env.BACKEND_URL || env.BACKEND_URL || `http://127.0.0.1:${backendPort}`;
  const clientPort = parseInt(process.env.CLIENT_PORT || env.CLIENT_PORT || '5173', 10);

  return {
    plugins: [react()],
    server: {
      port: clientPort,
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: true
        },
        '/summaries-files': {
          target: backendTarget,
          changeOrigin: true
        },
        '/media': {
          target: backendTarget,
          changeOrigin: true
        }
      }
    }
  };
});

