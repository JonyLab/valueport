import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/password.js";

describe("password", () => {
  it("verifies the correct password", async () => {
    const { hash, salt } = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", salt, hash)).toBe(true);
  });
  it("rejects a wrong password", async () => {
    const { hash, salt } = await hashPassword("hunter2");
    expect(await verifyPassword("nope", salt, hash)).toBe(false);
  });
  it("uses a random salt (two hashes differ)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
  it("rejects when salt is tampered", async () => {
    const { hash } = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", "AAAA", hash)).toBe(false);
  });
});
