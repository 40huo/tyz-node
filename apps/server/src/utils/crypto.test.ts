import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPasswordHash } from "./crypto";

/** Round-trip and format checks for the salted-sha256 users.password_hash scheme. */
describe("password hash", () => {
  test("verifies the password it was created from", async () => {
    const stored = await hashPassword("s3cret-pass");
    expect(await verifyPasswordHash(stored, "s3cret-pass")).toBe(true);
  });

  test("rejects a wrong password", async () => {
    const stored = await hashPassword("s3cret-pass");
    expect(await verifyPasswordHash(stored, "s3cret-pass!")).toBe(false);
  });

  test("format is scheme-tagged and salted (two hashes of one password differ)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a.startsWith("sha256$")).toBe(true);
    expect(a.split("$")).toHaveLength(3);
    expect(a).not.toBe(b);
  });

  test("rejects malformed stored values instead of throwing", async () => {
    for (const bad of ["", "sha256$onlytwo", "md5$abc$def", "$$", "sha256$$"]) {
      expect(await verifyPasswordHash(bad, "whatever")).toBe(false);
    }
  });
});
