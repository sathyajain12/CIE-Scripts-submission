import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // In development the API runs separately under `wrangler dev` (npm run dev:api).
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
