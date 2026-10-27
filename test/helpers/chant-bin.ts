/**
 * How the jobs `yodel ci` renders run chant here (#289): `yodel chant`, in
 * yodel's words, when the installed chant has `@intentius/chant/ci-product`
 * (chant#4550), so `yodel ci` renders through chant's product pipeline;
 * else `chant`, as a published chant before it renders.
 */

import { chantProduct } from "../../src/ci-words.js";

/** Whether `yodel ci` renders through chant's product pipeline with the chant installed here. */
export const PRODUCT = (await chantProduct()) !== undefined;

/** What a rendered job runs chant as. */
export const CHANT = PRODUCT ? "yodel chant" : "chant";
