/**
 * yodel.config.ts takes the keys of chant's product vocabulary and keeps
 * reading its older spellings: `ci.login` for `ci.identity`, `notify.key`
 * for `notify.webhookKey` and `notify.relay` for `notify.relayKey`. The
 * warnings and the error for a pair are chant's `productConfigProblems`.
 */

import { describe, expect, it } from "vitest";
import { PRODUCT_CONFIG_WORDS_FLOOR } from "@intentius/chant/ci-product";
import { checkVocabulary } from "../src/config/load.js";
import { YodelError } from "../src/project.js";

const FILE = "yodel.config.ts";
const login = { aws: { roleArn: "arn:aws:iam::123456789012:role/yodel-dev" } };

describe("yodel.config.ts and chant's vocabulary", () => {
  it("has the floor that carries the vocabulary", () => {
    expect(typeof PRODUCT_CONFIG_WORDS_FLOOR).toBe("string");
  });

  it("reads the vocabulary's keys with no warning, as the spellings the rest of yodel reads", () => {
    const { config, warnings } = checkVocabulary(
      { ci: { identity: login }, notify: { webhook: "URL", webhookKey: "KEY", relayKey: "RELAY", relayName: "yodel" } },
      FILE,
    );
    expect(warnings).toEqual([]);
    expect(config.ci?.login).toEqual(login);
    expect(config.notify).toEqual({ webhook: "URL", key: "KEY", relay: "RELAY", relayName: "yodel" });
  });

  it("keeps reading each older spelling, and warns naming the key", () => {
    const { config, warnings } = checkVocabulary({ ci: { login }, notify: { webhook: "URL", key: "KEY", relay: "RELAY" } }, FILE);
    expect(config.ci?.login).toEqual(login);
    expect(config.notify).toEqual({ webhook: "URL", key: "KEY", relay: "RELAY" });
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toMatch(/ci\.login is accepted as identity/);
    expect(warnings.join("\n")).toMatch(/notify\.key is accepted as notify\.webhookKey/);
    expect(warnings.join("\n")).toMatch(/notify\.relay is accepted as notify\.relayKey/);
  });

  it("refuses a spelling set beside its key", () => {
    expect(() => checkVocabulary({ ci: { login, identity: login } }, FILE)).toThrow(YodelError);
    expect(() => checkVocabulary({ ci: { login, identity: login } }, FILE)).toThrow(/ci.login and ci.identity are both set/);
    expect(() => checkVocabulary({ notify: { webhook: "U", key: "A", webhookKey: "B" } }, FILE)).toThrow(/both set/);
  });
});
