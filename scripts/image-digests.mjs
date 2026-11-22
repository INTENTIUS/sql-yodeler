// Writes dist/image-digests.json, the digests of the CI images a release's cut built, which the package carries so
// `yodel ci` can name the image yodel.config.ts `ci.imageBase` picks (src/ci/image-set.ts). It runs at the end of
// `npm run build`, after tsc.
//
// A release's build has CHANT_RELEASE_DIGESTS, the file chant's `release images` wrote: chant's releaseImagePins keys
// each image's digest by its reference at this version, `ghcr.io/intentius/sql-yodeler:<version>` and
// `ghcr.io/intentius/sql-yodeler:<version>-chainguard`. The npm target's `pins` (chant.config.ts) names this file, and
// the publish plan refuses a digest the release did not build. Any other build has no table: chant removes the file,
// so a package never ships a stale one, and `ci.imageBase` names no image.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseImagePins, writeReleaseImagePins } from "@intentius/chant/lifecycle/release-images";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The names and tags of the images come from the compiled module the package runs.
const { releaseImages, IMAGE_REPOSITORY } = await import(pathToFileURL(join(root, "dist/ci/image-set.js")).href);

try {
  const images = Object.fromEntries(releaseImages().map((i) => [i.name, `${IMAGE_REPOSITORY}:${i.tag(pkg.version)}`]));
  writeReleaseImagePins(releaseImagePins({ images, version: pkg.version }), { out: join(root, "dist/image-digests.json") });
} catch (e) {
  if (!e || typeof e.code !== "string") throw e;
  console.error(e.fix ? `${e.message}\n${e.fix}` : e.message);
  process.exit(1);
}
