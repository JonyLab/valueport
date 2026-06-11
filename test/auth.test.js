import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../src/auth.js";
const SECRET = "unit-secret";

describe("auth token with claims", () => {
  it("round-trips role and uid", async () => {
    const t = await signToken(SECRET, { role: "user", uid: 7 }, 3600);
    const c = await verifyToken(SECRET, t);
    expect(c).toMatchObject({ role: "user", uid: 7 });
    expect(typeof c.exp).toBe("number");
  });
  it("returns null for tampered token", async () => {
    const t = await signToken(SECRET, { role: "owner" }, 3600);
    expect(await verifyToken(SECRET, t + "x")).toBe(null);
  });
  it("returns null for wrong secret", async () => {
    const t = await signToken(SECRET, { role: "owner" }, 3600);
    expect(await verifyToken("other", t)).toBe(null);
  });
  it("returns null for expired token", async () => {
    const t = await signToken(SECRET, { role: "user", uid: 1 }, -1);
    expect(await verifyToken(SECRET, t)).toBe(null);
  });
  it("returns null for malformed token", async () => {
    expect(await verifyToken(SECRET, "a.b.c")).toBe(null);
    expect(await verifyToken(SECRET, "garbage")).toBe(null);
  });
  it("returns null when ttl was undefined (NaN exp must not verify)", async () => {
    const t = await signToken(SECRET, { role: "user", uid: 1 }, undefined);
    expect(await verifyToken(SECRET, t)).toBe(null);
  });
});
