import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAttendanceReply } from "../src/lib/reply-parser.js";

test("parses clear yes answers", () => {
  for (const s of ["Y", "yes", "Yep!", "sure", "I'm in", "👍"]) {
    assert.equal(parseAttendanceReply(s), "yes", s);
  }
});

test("parses clear no answers", () => {
  for (const s of ["N", "no", "Nope.", "I'm out tonight", "can't", "👎"]) {
    assert.equal(parseAttendanceReply(s), "no", s);
  }
});

test("returns pending on ambiguity", () => {
  for (const s of ["", "maybe later", "what's for dinner?"]) {
    assert.equal(parseAttendanceReply(s), "pending", s);
  }
});
