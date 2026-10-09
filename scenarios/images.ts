/**
 * The emulator's images, pinned by chant's sql lexicon, one per line: the
 * ClickHouse server (also the scratch Keeper cluster's) and the newest
 * Postgres. The claims workflow pre-pulls them from a mirror.
 */

import { clickhouseImage } from "@intentius/chant-lexicon-sql/spec/pin";
import { POSTGRES_LATEST_MAJOR, postgresImage } from "@intentius/chant-lexicon-sql/spec/postgres-pin";

process.stdout.write(`${clickhouseImage()}\n${postgresImage(POSTGRES_LATEST_MAJOR)}\n`);
