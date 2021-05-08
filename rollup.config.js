import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import replace from 'rollup-plugin-replace';
import commonjs from '@rollup/plugin-commonjs';
import { terser } from 'rollup-plugin-terser';

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
  plugins: [
    nodeResolve(),
    replace({
      // 'process.env.NODE_ENV': '"production"',
      'process.env.NODE_ENV': '"development"',
    }),
    commonjs({
      extensions: [ '.js', '.tsx' ],
    }),
    typescript(),
  ]
};
