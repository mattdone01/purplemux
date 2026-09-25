import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['server.ts'],
  format: ['cjs'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  external: ['next', 'react', 'react-dom', 'pino', 'pino-roll', 'pino-pretty', 'better-sqlite3'],
  noExternal: ['web-push', 'jose', 'ws', 'nanoid', 'zod', 'diff', 'smol-toml', 'dayjs'],
  esbuildOptions(options) {
    options.alias = {
      '@': './src',
    };
  },
});
