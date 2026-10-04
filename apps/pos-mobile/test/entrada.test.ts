import { test } from "node:test";
import assert from "node:assert/strict";
import { teclear } from "../lib/entrada.ts";
test("efectivo: decimal inicial parseable, un separador y dos centavos", () => {
  let value = "";
  for (const key of [".", "5", ".", "0", "9"]) value = teclear(value, key);
  assert.equal(value, "0.50");
  assert.equal(Number(value), 0.5);
  assert.equal(teclear(value, "⌫"), "0.5");
});
test("PIN: conserva ceros iniciales, límite y borrado", () => {
  let value = "";
  for (const key of "001234567") value = teclear(value, key, 8);
  assert.equal(value, "00123456");
  assert.equal(teclear(value, "⌫", 8), "0012345");
  assert.equal(teclear("", "⌫", 8), "");
});
