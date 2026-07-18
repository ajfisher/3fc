import { readFile } from "node:fs/promises";

import { parsePolicy } from "./policy.mjs";

const policyUrl = new URL("../../.github/review-policy.yml", import.meta.url);

try {
  const policy = parsePolicy(await readFile(policyUrl, "utf8"));
  console.log(`review policy v${policy.version} is valid (${policy.mode})`);
} catch (error) {
  console.error(`review policy is invalid: ${error.message}`);
  process.exitCode = 1;
}
