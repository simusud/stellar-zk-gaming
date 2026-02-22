import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
  ],
  // Load .env files from the parent directory (repo root)
  envDir: '..',
  // Treat .wasm files as static assets so imports resolve to URLs
  assetsInclude: ['**/*.wasm'],
  define: {
    global: 'globalThis'
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      buffer: path.resolve(__dirname, './node_modules/buffer/'),
      pino: 'pino/browser.js',
    },
    dedupe: ['@stellar/stellar-sdk']
  },
  optimizeDeps: {
    include: ['@stellar/stellar-sdk', '@stellar/stellar-sdk/contract', '@stellar/stellar-sdk/rpc', 'buffer'],
    // Exclude packages that import .wasm files so Vite doesn't mangle their asset URLs
    exclude: ['@noir-lang/backend_barretenberg', '@noir-lang/noir_js', '@noir-lang/acvm_js', '@noir-lang/noirc_abi', '@aztec/bb.js'],
    esbuildOptions: {
      define: {
        global: 'globalThis'
      }
    }
  },
  build: {
    target: 'esnext',
    commonjsOptions: {
      transformMixedEsModules: true
    }
  },
  server: {
    port: 3000,
    open: true
  }
})
