/**
 * The object the adopt claim's unsupported part makes (#251): one of a kind
 * chant's sql lexicon cannot declare on Postgres, so `yodel init --from`
 * must refuse it by name. The kind has to stay refused in chant's coverage
 * table (`@intentius/chant-lexicon-sql/coverage`); test/claims-undeclarable.test.ts
 * holds it to that, so a chant that starts declaring it fails a unit test
 * rather than the claim. An operator was this object until chant declared
 * operators.
 */

/** The coverage table's kind of the object. */
export const UNSUPPORTED_KIND = "conversion";

/** The object's name in schema `schema`, without the schema. */
const NAME = "latin1_utf8";

/** The SQL that makes it in `schema` (which must exist): an encoding conversion, from a function the server has. */
export const unsupportedSql = (schema: string): string => `CREATE CONVERSION ${schema}.${NAME} FOR 'LATIN1' TO 'UTF8' FROM iso8859_1_to_utf8`;

/** How chant's import and yodel's refusal name it: `conversion <schema>.latin1_utf8`. */
export const unsupportedName = (schema: string): string => `${UNSUPPORTED_KIND} ${schema}.${NAME}`;

/** The parts of the name, as chant's catalog probe returns them. */
export const unsupportedObject = (schema: string): { kind: string; schema: string; name: string } => ({ kind: UNSUPPORTED_KIND, schema, name: NAME });
