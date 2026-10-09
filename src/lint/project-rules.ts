/**
 * The project-wide rules `yodel lint` runs after its own: rules that need
 * more than the migrations directory, such as a server or the emulator.
 *
 * The replay check (#11, `../replay/`) belongs here: a {@link ProjectRule}
 * whose `check` replays the history into the dialect's emulator and reports
 * where the result differs from the recorded schema. Its findings take
 * levels from `yodel.config.ts` (`lint.rules.<id>`) like the built-in rules.
 */

import type { ProjectRule } from "./check.js";

export const projectRules: readonly ProjectRule[] = [];
