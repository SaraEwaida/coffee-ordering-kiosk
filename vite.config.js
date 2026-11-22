import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      // Order matters: the more specific prefix must come first, or /api
      // would swallow /api/kiosk and send kiosk traffic to the old V3 server.
      '/api/kiosk': 'http://localhost:4001',
      '/api/ops': 'http://localhost:4001',
      '/demo-pos': 'http://localhost:4001',
      // The Version 3 app, still running on 3001 for its own screens.
      '/api': 'http://localhost:3001',
    },
  },
});
