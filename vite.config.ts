import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./src/web", import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8788",
      // 本地 Vite 调试也要能直接点开 RSS 订阅地址
      "/rss": "http://127.0.0.1:8788",
      "/rss.xml": "http://127.0.0.1:8788",
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    // React 单独成块：发版后业务代码变了，vendor 还能命中浏览器缓存
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
        },
      },
    },
  },
});
