import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'logo.webp'],
      manifest: {
        name: 'RiderHub',
        short_name: 'RiderHub',
        description: 'Your complete motorcycle riding companion',
        theme_color: '#f97316',
        background_color: '#0f1117',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        lang: 'en-IN',
        categories: ['travel', 'navigation', 'lifestyle'],
        // Deliberately not locked: the map has a Rotate control and a landscape
        // layout, and a portrait lock would stop an installed copy honouring either.
        orientation: 'any',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Android crops an icon to whatever shape the launcher uses. Without a
          // maskable variant it letterboxes the square one inside a white circle,
          // which looks broken next to every other app on the phone.
          { src: 'icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp}'],
        // The Firebase SDK is large; the default 2 MB ceiling would silently drop the
        // main chunk from the precache and break offline start.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // No map-tile caching. Google Maps loads its tiles from Google at runtime and
        // its terms forbid storing them, so the app shell is all we can cache.
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy vendors so a code change does not invalidate all of them.
        manualChunks: {
          firebase: ['firebase/app', 'firebase/auth'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 1500,
  },
  server: {
    // 5173 is reserved by a Windows service on this machine, and Vite's default
    // behaviour is to silently hop to the next free port. That drift is dangerous: the
    // backend pins CORS to one origin, so a moved dev server fails in confusing ways,
    // and stale instances pile up on the old ports. strictPort makes it fail loudly.
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3001', ws: true, changeOrigin: true },
    },
  },
});
