/**
 * The room pages (docs-site/rooms.mjs, written by docs-site/pages.mjs): every
 * room has the same sections in the same order, and a room that links a page
 * or anchor that does not exist, or names a claim the record does not have,
 * fails the site build naming the room.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error docs-site/pages.mjs is plain JavaScript, with no types
import { checkRoom as untypedCheck, roomMarkdown as untypedMarkdown } from "../docs-site/pages.mjs";
// @ts-expect-error docs-site/rooms.mjs is plain JavaScript, with no types
import { ROLES, ROOMS, STARTS } from "../docs-site/rooms.mjs";

interface Room { id: string; claims: string[]; differs: Record<string, string[]>; first: { link: { label: string; href: string } }; tasks: unknown[]; background: unknown[]; reference: unknown[] }
type Rows = Map<string, Array<Record<string, string>>>;
const checkRoom = untypedCheck as (r: Room, slugs: Set<string>, rows: Rows) => void;
const roomMarkdown = untypedMarkdown as (r: Room, rows: Rows) => string;
const rooms = ROOMS as Room[];

const slugs = new Set(readdirSync("docs").filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3).toLowerCase()));
const record = JSON.parse(readFileSync("scenarios/claims-record.json", "utf8")) as { rows: Array<{ claim: string } & Record<string, string>> };
const rows: Rows = new Map();
for (const r of record.rows) rows.set(r.claim, [...(rows.get(r.claim) ?? []), r]);

describe("room pages", () => {
  it("has a room for every start and role", () => {
    for (const x of [...(STARTS as Array<{ room: string }>), ...(ROLES as Array<{ room: string }>)]) {
      expect(rooms.map((r) => r.id)).toContain(x.room);
    }
  });

  it("gives every room the same sections in the same order", () => {
    for (const r of rooms) {
      const headings = [...roomMarkdown(r, rows).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(headings, r.id).toEqual(["Works", "Differs", "First step", "Proof", "Then read"]);
    }
  });

  it("refuses a room whose link or claim leads nowhere, naming the room", () => {
    const [r] = rooms;
    if (!r) throw new Error("no rooms");
    expect(() => {
      checkRoom(r, slugs, rows);
    }).not.toThrow();
    expect(() => {
      checkRoom({ ...r, tasks: [{ label: "Gone", href: "gone" }] }, slugs, rows);
    }).toThrow(`room ${r.id} links "Gone" to gone, but docs/ has no page gone.md`);
    expect(() => {
      checkRoom({ ...r, tasks: [{ label: "Drift", href: "drift#nope" }] }, slugs, rows);
    }).toThrow(`room ${r.id} links "Drift" to drift#nope, but docs/drift.md has no heading with the anchor #nope`);
    expect(() => {
      checkRoom({ ...r, claims: ["nope"] }, slugs, rows);
    }).toThrow(`room ${r.id} names the claim nope`);
  });
});
