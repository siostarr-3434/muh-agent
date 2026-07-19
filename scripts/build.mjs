import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { rollup } from '@rollup/wasm-node'
import babel from '@rollup/plugin-babel'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import replace from '@rollup/plugin-replace'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'dist')
const nodeEnvironment = process.env.NODE_ENV === 'development' ? 'development' : 'production'

await rm(dist, { recursive: true, force: true })
await mkdir(resolve(dist, 'assets'), { recursive: true })

const bundle = await rollup({
  input: resolve(root, 'src/main.tsx'),
  plugins: [
    nodeResolve({ extensions: ['.mjs', '.js', '.jsx', '.json', '.ts', '.tsx'] }),
    commonjs(),
    replace({
      preventAssignment: true,
      values: {
        'process.env.NODE_ENV': JSON.stringify(nodeEnvironment),
      },
    }),
    babel({
      babelHelpers: 'bundled',
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
      presets: [
        ['@babel/preset-env', { targets: { esmodules: true }, modules: false }],
        ['@babel/preset-react', { runtime: 'automatic' }],
        '@babel/preset-typescript',
      ],
    }),
  ],
})

await bundle.write({
  file: resolve(dist, 'assets/main.js'),
  format: 'es',
  sourcemap: nodeEnvironment === 'development',
})
await bundle.close()

await writeFile(resolve(dist, 'index.html'), await readFile(resolve(root, 'index.html')))
await writeFile(resolve(dist, 'styles.css'), await readFile(resolve(root, 'src/styles.css')))
await cp(resolve(root, 'public'), resolve(dist), { recursive: true })
console.log('Build complete: dist/ (Rollup WASM, native binding gerektirmez)')
