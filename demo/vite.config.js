import { svelte } from "@sveltejs/vite-plugin-svelte";
import { ChemicalVitePlugin } from "chemicaljs";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte(), ChemicalVitePlugin()],
  // dlpcc is linked from the repo root, which has no controller of its own,
  // so resolve dlpcc/scramjet's import of it from here.
  resolve: { dedupe: ["@mercuryworkshop/scramjet-controller"] },
});
