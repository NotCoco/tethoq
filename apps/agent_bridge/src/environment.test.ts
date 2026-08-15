import assert from "node:assert/strict";
import test from "node:test";
import { tethoqEnvironmentFlag, tethoqEnvironmentValue } from "./environment.js";

test("TETHOQ environment names are canonical with UAR fallbacks", () => {
  assert.equal(tethoqEnvironmentValue({ TETHOQ_BRIDGE_PORT: "9000", UAR_BRIDGE_PORT: "8000" }, "TETHOQ_BRIDGE_PORT"), "9000");
  assert.equal(tethoqEnvironmentValue({ UAR_BRIDGE_PORT: "8000" }, "TETHOQ_BRIDGE_PORT"), "8000");
  assert.equal(tethoqEnvironmentValue({}, "TETHOQ_BRIDGE_PORT"), undefined);
  assert.equal(tethoqEnvironmentFlag({ TETHOQ_ENABLE_CODEX_LOCAL_STATE: "1" }, "TETHOQ_ENABLE_CODEX_LOCAL_STATE"), true);
  assert.equal(tethoqEnvironmentFlag({ UAR_ENABLE_CODEX_LOCAL_STATE: "1" }, "TETHOQ_ENABLE_CODEX_LOCAL_STATE"), true);
  assert.equal(tethoqEnvironmentFlag({ TETHOQ_ENABLE_CODEX_LOCAL_STATE: "0", UAR_ENABLE_CODEX_LOCAL_STATE: "1" }, "TETHOQ_ENABLE_CODEX_LOCAL_STATE"), false);
});
