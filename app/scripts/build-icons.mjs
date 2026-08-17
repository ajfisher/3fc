import { icons } from "@iconify-json/lucide";
import { getIconData, getIconsCSS } from "@iconify/utils";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ICON_NAMES } from "../dist/ui/icon-names.js";
import { validateClientIconNames } from "./validate-client-icons.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(appRoot, "dist/ui/icons.css");
const clientSourcePath = resolve(appRoot, "src/ui/setup-flow.js");
const missingIcons = ICON_NAMES.filter((name) => getIconData(icons, name) === null);

if (missingIcons.length > 0) {
  throw new Error(`Lucide icons missing from @iconify-json/lucide: ${missingIcons.join(", ")}`);
}

validateClientIconNames(readFileSync(clientSourcePath, "utf8"), ICON_NAMES, clientSourcePath);

const css = getIconsCSS(icons, [...ICON_NAMES], {
  commonSelector: '[data-ui="icon"]',
  iconSelector: '[data-icon="{name}"]',
  format: "expanded",
});

if (!css.trim()) {
  throw new Error("Iconify generated an empty icon stylesheet.");
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `/* Generated from @iconify-json/lucide. Do not edit by hand. */\n${css}`,
  "utf8",
);
