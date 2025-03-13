import { defineConfig } from 'vite';
import { resolve } from 'path';
import legacy from '@vitejs/plugin-legacy';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        // Make all JS assets entry points rather than chunks
        manualChunks: undefined, // Disable code splitting
        inlineDynamicImports: true, // Inline all dynamic imports
      },
    },
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
  },
  define: {
    'process.env': JSON.stringify(process.env),
    'global': {},
    // Make sure PROJECT_ID from .env is accessible
    'process.env.PROJECT_ID': JSON.stringify(process.env.PROJECT_ID),
  },
  resolve: {
    alias: {
      process: 'process/browser',
      stream: 'stream-browserify',
      buffer: 'buffer',
      util: 'util',
    },
  },
  plugins: [
    legacy({
      targets: ['defaults', 'not IE 11'],
    }),
    viteSingleFile({
      removeViteModuleLoader: false, // Keep the module loader
      inlinePattern: ['**/*.js', '**/*.css'], // Explicitly define what to inline
    }),
  ],
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  server: {
    port: 9000,
    host: true,
    open: true,
  },
});