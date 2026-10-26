import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Os testes usam um banco real e compartilham estado: rodam em sequência.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
