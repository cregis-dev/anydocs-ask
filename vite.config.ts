import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist/console-ui',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    lib: {
      entry: 'src/console-ui/index.tsx',
      formats: ['es'],
      fileName: () => 'index-app.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith('.css') ? 'index-app.css' : '[name][extname]',
      },
    },
  },
});
