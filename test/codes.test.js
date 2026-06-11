import { describe, it, expect } from "vitest";
import { generateCode } from "../src/codes.js";

describe("generateCode", () => {
  it("matches XXXX-XXXX-XXXX of unambiguous base32 chars", () => {
    expect(generateCode()).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });
  it("is random (100 codes all unique)", () => {
    const set = new Set();
    for (let i = 0; i < 100; i++) set.add(generateCode());
    expect(set.size).toBe(100);
  });
});
