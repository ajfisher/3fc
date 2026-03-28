import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderComponentShowcasePage,
  renderGamePage,
  renderLeaguePage,
  renderMagicLinkCallbackPage,
  renderSeasonPage,
  renderSetupHomePage,
  renderSignInPage,
} from "./ui/layout.js";

export interface StaticSiteBuildOptions {
  apiBaseUrl: string;
  outputDir: string;
}

interface StaticRoute {
  path: string;
  html: string;
}

interface StaticAsset {
  outputPath: string;
  candidateSources: string[];
}

const STATIC_ASSETS: StaticAsset[] = [
  {
    outputPath: "ui/styles.css",
    candidateSources: [
      fileURLToPath(new URL("./ui/styles.css", import.meta.url)),
      resolve(process.cwd(), "dist/ui/styles.css"),
      resolve(process.cwd(), "app/dist/ui/styles.css"),
      resolve(process.cwd(), "src/ui/styles.css"),
      resolve(process.cwd(), "app/src/ui/styles.css"),
    ],
  },
  {
    outputPath: "ui/modal.js",
    candidateSources: [
      fileURLToPath(new URL("./ui/modal.js", import.meta.url)),
      resolve(process.cwd(), "dist/ui/modal.js"),
      resolve(process.cwd(), "app/dist/ui/modal.js"),
      resolve(process.cwd(), "src/ui/modal.js"),
      resolve(process.cwd(), "app/src/ui/modal.js"),
    ],
  },
  {
    outputPath: "ui/setup-flow.js",
    candidateSources: [
      fileURLToPath(new URL("./ui/setup-flow.js", import.meta.url)),
      resolve(process.cwd(), "dist/ui/setup-flow.js"),
      resolve(process.cwd(), "app/dist/ui/setup-flow.js"),
      resolve(process.cwd(), "src/ui/setup-flow.js"),
      resolve(process.cwd(), "app/src/ui/setup-flow.js"),
    ],
  },
  {
    outputPath: "ui/auth-flow.js",
    candidateSources: [
      fileURLToPath(new URL("./ui/auth-flow.js", import.meta.url)),
      resolve(process.cwd(), "dist/ui/auth-flow.js"),
      resolve(process.cwd(), "app/dist/ui/auth-flow.js"),
      resolve(process.cwd(), "src/ui/auth-flow.js"),
      resolve(process.cwd(), "app/src/ui/auth-flow.js"),
    ],
  },
];

function writeRoute(outputDir: string, routePath: string, html: string): void {
  const normalizedRoute = routePath.replace(/^\/+/, "").replace(/\/+$/, "");
  const targetPath =
    normalizedRoute.length === 0
      ? resolve(outputDir, "index.html")
      : resolve(outputDir, normalizedRoute, "index.html");

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, html, "utf8");
}

export function buildStaticSite(options: StaticSiteBuildOptions): string {
  const outputDir = resolve(options.outputDir);
  const routes: StaticRoute[] = [
    { path: "/", html: renderSetupHomePage(options.apiBaseUrl) },
    { path: "/setup", html: renderSetupHomePage(options.apiBaseUrl) },
    { path: "/sign-in", html: renderSignInPage(options.apiBaseUrl, "/setup") },
    { path: "/auth/callback", html: renderMagicLinkCallbackPage(options.apiBaseUrl) },
    { path: "/ui/components", html: renderComponentShowcasePage(options.apiBaseUrl) },
    { path: "/leagues", html: renderLeaguePage(options.apiBaseUrl, "") },
    { path: "/seasons", html: renderSeasonPage(options.apiBaseUrl, "") },
    { path: "/games", html: renderGamePage(options.apiBaseUrl, { gameId: "" }) },
  ];

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  for (const asset of STATIC_ASSETS) {
    const sourcePath = asset.candidateSources.find((candidate) => existsSync(candidate));
    if (!sourcePath) {
      throw new Error(`Missing static asset source for ${asset.outputPath}.`);
    }

    const targetPath = resolve(outputDir, asset.outputPath);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }

  for (const route of routes) {
    writeRoute(outputDir, route.path, route.html);
  }

  return outputDir;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3001";
  const outputDir = process.env.STATIC_SITE_OUTPUT_DIR ?? resolve(process.cwd(), "dist-static");

  const builtOutputDir = buildStaticSite({
    apiBaseUrl,
    outputDir,
  });

  process.stdout.write(`${builtOutputDir}\n`);
}
