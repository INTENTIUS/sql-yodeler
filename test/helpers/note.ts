/**
 * The plan note `yodel plan --pr-note` hands to chant's note job, through chant's renderer
 * (#290), from the repository's root: what the cases that read the note
 * render. yodel's own layout left in 0.12 (#303).
 */

import { renderPlanNote, renderTenantSetNote } from "../../src/pr/note.js";
import type { VersionedPlan } from "../../src/pr/model.js";
import { renderTenantSetMarkdown, type TenantSetPlan } from "../../src/pr/tenants.js";
import { repoRoot } from "./run.js";

/** One environment's note. */
export const planNote = (plan: VersionedPlan): Promise<string> => renderPlanNote(plan, { dir: repoRoot });

/** A tenant set's note. */
export const setNote = async (plan: TenantSetPlan): Promise<string> => (await renderTenantSetNote(plan, { dir: repoRoot })) ?? renderTenantSetMarkdown(plan);
