/**
 * The digest a plan comment gives for the apply gate, in either layout
 * `yodel plan --format markdown` posts:
 *
 * - chant's note (src/pr/note.ts, #290), used once the installed chant's
 *   note fits yodel: `Plan digest: \`<digest>\`` on a line of its own.
 * - yodel's own (src/pr/render.ts), on a chant whose note does not fit:
 *   `Plan digest the apply gate binds: \`<digest>\``.
 *
 * yodel's own line for a wave outside the pipeline
 * (`Plan digest \`yodel apply <env>\` binds, outside the pipeline`) is not
 * the gate's digest, and is not read.
 */

const DIGEST_LINE = /^Plan digest(?: the apply gate binds)?: `(jcs1-sha256:[0-9a-f]{64})`/m;

/** The gate's digest the comment gives, or undefined when it gives none. */
export function commentDigest(body: string): string | undefined {
  return DIGEST_LINE.exec(body)?.[1];
}
