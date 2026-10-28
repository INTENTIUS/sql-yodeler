import type { Command } from "../command.js";
import { apply } from "./apply.js";
import { ci } from "./ci.js";
import { config } from "./config.js";
import { approve } from "./approve.js";
import { check } from "./check.js";
import { checkpoint } from "./checkpoint.js";
import { cleanup } from "./cleanup.js";
import { create } from "./create.js";
import { docs } from "./docs.js";
import { drift } from "./drift.js";
import { emulator } from "./emulator.js";
import { init } from "./init.js";
import { lint } from "./lint.js";
import { mcp } from "./mcp.js";
import { newCommand } from "./new.js";
import { override } from "./override.js";
import { plan } from "./plan.js";
import { rebase } from "./rebase.js";
import { repair } from "./repair.js";
import { revert } from "./revert.js";
import { report } from "./report.js";
import { status } from "./status.js";
import { test } from "./test.js";
import { upgrade } from "./upgrade.js";

/** Every verb, in the order `yodel --help` lists them. */
export const commands: readonly Command[] = [
  create,
  init,
  emulator,
  plan,
  apply,
  approve,
  override,
  newCommand,
  checkpoint,
  lint,
  check,
  test,
  status,
  report,
  drift,
  docs,
  ci,
  upgrade,
  config,
  rebase,
  repair,
  revert,
  cleanup,
  mcp,
];
