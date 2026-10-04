import { buildSync } from "esbuild";

// One renderer serves server fixtures and classic deferred browser scripts.
buildSync({ entryPoints: ["src/ui/player-presentation.ts"], bundle: true, format: "iife",
  globalName: "ThreeFcPlayers", footer: { js: "globalThis.ThreeFcPlayers = ThreeFcPlayers;" },
  outfile: "dist/ui/player-presentation-browser.js", target: "es2022" });

for (const page of ["player-profile", "player-settings", "achievement-gallery"]) {
  buildSync({ entryPoints: [`src/ui/${page}-browser.ts`], bundle: true,
    format: "iife", outfile: `dist/ui/${page}-browser.js`, target: "es2022" });
}
