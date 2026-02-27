import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: false
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          'three-core': ['three'],
          'three-post': [
            'three/addons/postprocessing/EffectComposer.js',
            'three/addons/postprocessing/RenderPass.js',
            'three/addons/postprocessing/UnrealBloomPass.js',
            'three/addons/postprocessing/ShaderPass.js',
            'three/addons/shaders/FXAAShader.js',
          ],
        },
      },
    },
  },
});
