import { expect, test } from "vitest";
import { stale } from "../.github/src/render.js";

test(".github/workflows matches its declarations in .github/src (npm run workflows renders them)", () => {
  expect(stale()).toEqual([]);
});
