import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, newInviteCode, verifyPassword } from "../src/auth.js";

test("hashPassword round-trips and rejects the wrong password", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("wrong horse battery", stored), false);
});

test("hashPassword salts each hash", async () => {
  assert.notEqual(await hashPassword("same password"), await hashPassword("same password"));
});

test("verifyPassword rejects malformed hashes", async () => {
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
});

test("newInviteCode is 12 unambiguous characters", () => {
  for (let i = 0; i < 50; i++) assert.match(newInviteCode(), /^[A-HJKMNP-Z2-9]{12}$/);
});
