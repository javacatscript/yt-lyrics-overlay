import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';

import manifest from './manifest.config';

export default defineConfig({
  build: {
    // Unpacked local build: readable output is worth more than a few bytes.
    minify: false,
    sourcemap: true,
  },
  plugins: [
    webExtension({
      manifest: () => manifest,
      // Nothing to open automatically; the extension is loaded unpacked.
      disableAutoLaunch: true,
    }),
  ],
});
