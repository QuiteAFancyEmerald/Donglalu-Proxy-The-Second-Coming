import { svelte } from "@sveltejs/vite-plugin-svelte";
import { ChemicalVitePlugin } from "chemicaljs";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte(), ChemicalVitePlugin()],
});
