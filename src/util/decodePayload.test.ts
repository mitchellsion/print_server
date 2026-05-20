import test from "node:test";
import assert from "node:assert/strict";
import { decodePayload } from "./decodePayload.js";

test("decodePayload base64", () => {
  assert.equal(decodePayload("aGVsbG8=", "base64").toString("utf8"), "hello");
});

test("decodePayload hex (with whitespace)", () => {
  assert.equal(decodePayload("48 65 6c 6c 6f", "hex").toString("utf8"), "Hello");
});

test("decodePayload utf8", () => {
  assert.equal(decodePayload("Hello", "utf8").toString("utf8"), "Hello");
});
