import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Em desenvolvimento, o Vite faz o papel do servidor.mjs: /api e /mcp vão para os serviços locais.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/mcp": "http://localhost:3001",
    },
  },
  build: { sourcemap: true, target: "es2022" },
});
