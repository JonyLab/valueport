import { describe, it, expect } from "vitest";
import { validateUsername, validateSlug, rowToUser } from "../src/users.js";

describe("validateUsername", () => {
  it("accepts 3-20 of [A-Za-z0-9_-]", () => {
    expect(validateUsername("jony_2")).toBe(true);
    expect(validateUsername("ab")).toBe(false);
    expect(validateUsername("has space")).toBe(false);
    expect(validateUsername("a".repeat(21))).toBe(false);
  });
});
describe("validateSlug", () => {
  it("accepts 3-32 lowercase/digit/hyphen", () => {
    expect(validateSlug("my-board")).toBe(true);
    expect(validateSlug("UP")).toBe(false);
    expect(validateSlug("a")).toBe(false);
  });
});
describe("rowToUser", () => {
  it("maps a row without exposing hash/salt", () => {
    const r = { id: 3, username: "jony", pass_hash: "x", pass_salt: "y", board_slug: "j", board_name: "J", created_at: "t" };
    expect(rowToUser(r)).toEqual({ id: 3, username: "jony", boardSlug: "j", boardName: "J", createdAt: "t" });
  });
});
