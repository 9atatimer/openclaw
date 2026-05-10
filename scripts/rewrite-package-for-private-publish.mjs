#!/usr/bin/env -S node --import tsx
// Rewrites package.json in place for the private GH Packages publish path.
// Inputs come from env vars so the same script works in CI and locally.
//   PRIVATE_NPM_SCOPE        e.g. "@9atatimer"  (required)
//   PRIVATE_NPM_DIST_TAG     e.g. "preprod"     (required)
//   PRIVATE_NPM_BUILD_LABEL  e.g. "preprod.42"  (required)  -> appended to version
//   PRIVATE_NPM_REGISTRY     defaults to https://npm.pkg.github.com
// The source name (`openclaw`) is preserved as a heuristic safety check; if it
// changes upstream the rewrite still works but logs a warning.

import { readFileSync, writeFileSync } from "node:fs";

const PACKAGE_PATH = "package.json";
const SOURCE_NAME_HINT = "openclaw";

function requireEnv(key) {
  const value = process.env[key];
  if (!value || value.trim().length === 0) {
    console.error(`rewrite-package-for-private-publish: missing required env ${key}`);
    process.exit(1);
  }
  return value.trim();
}

function isSemverPrereleaseLabel(label) {
  return /^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(label);
}

function main() {
  const scope = requireEnv("PRIVATE_NPM_SCOPE");
  const distTag = requireEnv("PRIVATE_NPM_DIST_TAG");
  const buildLabel = requireEnv("PRIVATE_NPM_BUILD_LABEL");
  const registry = (process.env.PRIVATE_NPM_REGISTRY ?? "https://npm.pkg.github.com").trim();

  if (!scope.startsWith("@") || scope.includes("/")) {
    console.error(
      `rewrite-package-for-private-publish: PRIVATE_NPM_SCOPE must look like "@owner", got ${scope}`,
    );
    process.exit(1);
  }
  if (!isSemverPrereleaseLabel(buildLabel)) {
    console.error(
      `rewrite-package-for-private-publish: PRIVATE_NPM_BUILD_LABEL is not a valid semver prerelease label: ${buildLabel}`,
    );
    process.exit(1);
  }

  const raw = readFileSync(PACKAGE_PATH, "utf8");
  const pkg = JSON.parse(raw);

  if (pkg.name !== SOURCE_NAME_HINT) {
    console.warn(
      `rewrite-package-for-private-publish: source name is "${pkg.name}", expected "${SOURCE_NAME_HINT}" — continuing.`,
    );
  }
  const baseVersion = String(pkg.version ?? "");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(baseVersion)) {
    console.error(
      `rewrite-package-for-private-publish: refusing to publish, package.json version is not a clean MAJOR.MINOR.PATCH: ${baseVersion}`,
    );
    process.exit(1);
  }

  const targetName = `${scope}/${SOURCE_NAME_HINT}`;
  const targetVersion = `${baseVersion}-${buildLabel}`;
  const publishConfig = { ...(pkg.publishConfig ?? {}), registry, tag: distTag };

  const next = { ...pkg, name: targetName, version: targetVersion, publishConfig };

  writeFileSync(PACKAGE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  console.log(
    `rewrite-package-for-private-publish: ${pkg.name}@${baseVersion} -> ${targetName}@${targetVersion} (registry=${registry}, tag=${distTag})`,
  );
}

main();
