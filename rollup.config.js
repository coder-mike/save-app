import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import {terser} from 'rollup-plugin-terser';

export default {
  input: 'src/script.tsx',
  output: {
    file: 'public/script.js',
    format: 'iife',
    name: 'squirrel',
    globals: {
      'immer': 'immer'
    },
    sourcemap: true,
    // plugins: [terser()]
  },
  plugins: [nodeResolve(), typescript()]
};
