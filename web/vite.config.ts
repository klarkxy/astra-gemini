import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const adminProxy = {
  target: "http://127.0.0.1:3940",
  changeOrigin: true,
  configure(proxy: { on: (ev: string, fn: (req: { removeHeader: (h: string) => void }) => void) => void }) {
    proxy.on("proxyReq", (proxyReq) => {
      // 服务端校验 Origin/Sec-Fetch-Site，跨端口开发请求需去掉
      proxyReq.removeHeader("origin");
      proxyReq.removeHeader("sec-fetch-site");
    });
  }
};

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") }
  },
  build: {
    outDir: "../src",
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(__dirname, "ui.html")
    }
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": adminProxy,
      "/remote": adminProxy
    }
  }
});
