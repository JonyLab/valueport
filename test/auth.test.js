import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../src/auth.js";

const SECRET = "unit-secret";

describe("auth token", () => {
  it("verifies a freshly signed token", async () => {
    const token = await signToken(SECRET, 3600);
    expect(await verifyToken(SECRET, token)).toBe(true);
  });
  it("rejects a tampered token", async () => {
    const token = await signToken(SECRET, 3600);
    expect(await verifyToken(SECRET, token + "x")).toBe(false);
  });
  it("rejects a token signed with a different secret", async () => {
    const token = await signToken(SECRET, 3600);
    expect(await verifyToken("other-secret", token)).toBe(false);
  });
  it("rejects an expired token", async () => {
    const token = await signToken(SECRET, -1);
    expect(await verifyToken(SECRET, token)).toBe(false);
  });
});
