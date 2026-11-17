/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((dep) => !dep.includes("mock"));
      },
    },
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "maplibre", test: /maplibre-gl/, priority: 30 },
            // three.js only serves the playback truck; it stays in a lazy chunk of its own.
            { name: "three", test: /node_modules[\\/]three[\\/]/, priority: 20 },
            { name: "vendor", test: /node_modules/, priority: 10 },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    // App integration tests render real backend payloads; under a parallel run they can pass 5 s.
    testTimeout: 15_000,
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
