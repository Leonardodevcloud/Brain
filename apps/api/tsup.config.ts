import { defineConfig } from "tsup";

// Só o código dos pacotes internos (@cerebro/*) entra no bundle. Dependências de terceiros
// ficam externas e são instaladas no deploy — por isso o package.json do app as declara.
export default defineConfig({
  entry: ["src/index.ts", "src/cli/criar-admin.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: [/^@cerebro\//],
  skipNodeModulesBundle: true,
});
