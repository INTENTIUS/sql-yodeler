import type { Command } from "../command.js";
import { apply } from "./apply.js";
import { ci } from "./ci.js";
import { approve } from "./approve.js";
import { docs } from "./docs.js";
import { drift } from "./drift.js";
import { init } from "./init.js";
import { lint } from "./lint.js";
import { mcp } from "./mcp.js";
import { newCommand } from "./new.js";
import { override } from "./override.js";
import { plan } from "./plan.js";
import { rebase } from "./rebase.js";
import { repair } from "./repair.js";
import { report } from "./report.js";
import { status } from "./status.js";

/** Every verb, in the order `yodel --help` lists them. */
export const commands: readonly Command[] = [
  init,
  plan,
  apply,
  approve,
  override,
  newCommand,
  lint,
  status,
  report,
  drift,
  docs,
  ci,
  rebase,
  repair,
  mcp,
];
