import { buildSync } from "esbuild";

// One renderer serves server fixtures and classic deferred browser scripts.
buildSync({ entryPoints: ["src/ui/player-presentation.ts"], bundle: true, format: "iife",
  globalName: "ThreeFcPlayers", footer: { js: "globalThis.ThreeFcPlayers = ThreeFcPlayers;" },
  outfile: "dist/ui/player-presentation-browser.js", target: "es2022" });
