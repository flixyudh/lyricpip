import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

export default defineConfig({
  plugins: [pluginReact()],
  html: {
    title: 'LyricPiP — Synced Lyrics & Picture-in-Picture',
    favicon: './src/favicon.svg',
  },
  output: {
    assetPrefix: './',
  },
});
