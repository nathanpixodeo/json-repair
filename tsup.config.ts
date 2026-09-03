import { defineConfig } from 'tsup';

export default defineConfig([
  {
    name: 'library',
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    target: 'es2022',
    platform: 'neutral',
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    splitting: false,
  },
  {
    name: 'cli',
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    dts: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    splitting: false,
  },
]);
