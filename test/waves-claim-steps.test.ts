/**
 * The waves claim's steps part counts how many times the before command
 * ran from the lines it appends to a file. Under BREAK the rendered spec
 * also runs that command as a before-plan hook, which chant runs with
 * CHANT_TARGET and without YODEL_ENV: that run must still count, or the
 * break goes uncaught (the line used to be empty and was filtered out).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandRuns, notifyCommand } from "../scenarios/claims/waves.js";

const sh = (command: string, env: NodeJS.ProcessEnv) => {
  const ran = spawnSync("sh", ["-c", command], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: "pipe" });
  expect(ran.status).toBe(0);
};

describe("the waves claim's steps part", () => {
  it("counts a run yodel makes under the lock and one chant makes as a stage hook, so the before-plan break is two runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-waves-steps-"));
    try {
      const file = join(dir, "notify.log");
      const command = notifyCommand(file);
      // Plain: yodel runs the before step once, under the lock, with YODEL_ENV.
      sh(command, { YODEL_ENV: "staging" });
      expect(commandRuns(readFileSync(file, "utf8"))).toBe(1);
      // BREAK: chant also runs it when it plans the wave, with CHANT_TARGET and no YODEL_ENV.
      sh(command, { CHANT_TARGET: "staging" });
      expect(commandRuns(readFileSync(file, "utf8"))).toBe(2);
      // Neither variable: still a line, still a run.
      sh(command, {});
      expect(commandRuns(readFileSync(file, "utf8"))).toBe(3);
      expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toEqual(["ran staging", "ran staging", "ran "]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts every line, an empty one too", () => {
    expect(commandRuns("")).toBe(0);
    expect(commandRuns("\n")).toBe(1);
    expect(commandRuns("staging\n\n")).toBe(2);
    expect(commandRuns("staging")).toBe(1);
  });
});
