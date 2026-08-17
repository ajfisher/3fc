import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import lucidePackage from "@iconify-json/lucide/package.json" with { type: "json" };
import iconifyUtilsPackage from "@iconify/utils/package.json" with { type: "json" };

import { ICON_NAMES } from "../ui/icon-names.js";

test("generated Lucide asset contains exactly the local allow-list", () => {
  const css = readFileSync(resolve(process.cwd(), "dist/ui/icons.css"), "utf8");
  const generatedNames = Array.from(css.matchAll(/\[data-icon="([^"]+)"\]/g), (match) => match[1]);

  assert.deepEqual(generatedNames, [...ICON_NAMES]);
  assert.match(css, /data:image\/svg\+xml/);
  assert.doesNotMatch(css, /url\(["']?https?:\/\//);
});

test("Lucide dependency provenance and licence stay explicit", () => {
  assert.equal(lucidePackage.name, "@iconify-json/lucide");
  assert.equal(lucidePackage.license, "ISC");
  assert.equal(iconifyUtilsPackage.name, "@iconify/utils");
  assert.equal(iconifyUtilsPackage.license, "MIT");
});

test("client icon validation rejects names outside the generated allow-list", async () => {
  // The validator is a build-time JavaScript module rather than application code.
  // @ts-expect-error No declaration file is needed for the build script module.
  const { validateClientIconNames } = await import("../../../scripts/validate-client-icons.mjs") as {
    validateClientIconNames: (source: string, names: readonly string[]) => string[];
  };

  const clientSource = readFileSync(resolve(process.cwd(), "src/ui/setup-flow.js"), "utf8");
  assert(validateClientIconNames(clientSource, ICON_NAMES).includes("loader-circle"));

  assert.deepEqual(
    validateClientIconNames('renderClientIconButton({ icon: "eye", label: "View" });', ICON_NAMES),
    ["eye"],
  );
  assert.throws(
    () => validateClientIconNames('renderClientIconButton({ icon: "missing-icon", label: "Broken" });', ICON_NAMES),
    /missing from the Lucide allow-list: missing-icon/,
  );
});
