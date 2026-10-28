/**
 * The end-to-end tests that chant's e2e harness retires (INTENTIUS/sql-yodeler#302).
 *
 * With a chant that has the harness (`@intentius/chant/e2e-harness` and its
 * E2E_HARNESS_FLOOR, scenarios/harness/harness.ts), the harness scenarios
 * in scenarios/harness/scenarios/ are where the forge and approval claims
 * get their rows, on the harness's Forgejo and runner:
 *
 * - test/e2e/forgejo.test.ts, the plan comment through chant's Forgejo
 *   client on a real Forgejo: every sy-forge and sy-approval scenario's
 *   first step expects the plan comment the plan job posted through that
 *   client. Updating it in place is test/pr-forge.test.ts's, with a fake.
 * - test/e2e/pr-comment.test.ts's first case, the comment's digest is the
 *   one the gate asks for and approving it lets the apply after merge run:
 *   the note, note-plan, note-approve and note-apply steps of
 *   sy-approval-<dialect> and sy-forge-<dialect>.
 *
 * pr-comment.test.ts's other two cases, the moved plan and the moved live
 * schema named in yodel plan and the comment, are yodel plan's own output
 * and stay on every chant.
 *
 * On a chant without the harness the retired tests run as they did, so the
 * claims keep a path that runs.
 */

import { loadHarness } from "../../scenarios/harness/harness.js";

/** Whether chant's harness is installed, so the harness scenarios are the source of what the retired tests showed. */
export const harnessCovers: boolean = (await loadHarness()) !== undefined;
