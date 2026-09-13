import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { NextRequest, NextResponse } from "next/server.js";
import ts from "typescript";

// Execute the real route with only configuration and the auth service replaced.
// Source-string checks cannot prove that a redirect stays on our own origin.
const { outputText } = ts.transpileModule(
  await readFile(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
);

function callback({ configured = true, error = null } = {}) {
  const exchanges = [];
  const exports = {};
  runInNewContext(outputText, {
    exports, URL,
    require(id) {
      if (id === "next/server") return { NextResponse };
      if (id === "@/lib/config") return { hasSupabaseConfig: () => configured };
      if (id === "@/lib/supabase/server") return { createClient: async () => ({
        auth: { exchangeCodeForSession: async (code) => { exchanges.push(code); return { error }; } },
      }) };
      throw new Error(`Unexpected route dependency: ${id}`);
    },
  });
  return { GET: exports.GET, exchanges };
}

function request(next, code = "one-time-code") {
  const url = new URL("https://tethoq.example/auth/callback");
  if (code !== null) url.searchParams.set("code", code);
  if (next !== undefined) url.searchParams.set("next", next);
  return new NextRequest(url);
}

test("successful OAuth callbacks keep only local return destinations", async () => {
  for (const [next, expected] of [
    [undefined, "/dashboard"],
    ["/dashboard/computers?tab=paired#details", "/dashboard/computers?tab=paired#details"],
    ["https://attacker.invalid/", "/dashboard"],
    ["//attacker.invalid/", "/dashboard"],
    ["/\\attacker.invalid/", "/dashboard"],
    ["/\t/attacker.invalid/", "/dashboard"],
    ["/\n/attacker.invalid/", "/dashboard"],
    ["relative-path", "/dashboard"],
  ]) {
    const route = callback();
    const response = await route.GET(request(next));
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), `https://tethoq.example${expected}`, JSON.stringify(next));
    assert.deepEqual(route.exchanges, ["one-time-code"]);
  }
});

test("missing configuration, missing codes, and rejected codes return to sign-in", async () => {
  for (const scenario of [
    { configured: false, code: "one-time-code", exchanges: [] },
    { code: null, exchanges: [] },
    { code: "rejected-code", error: new Error("Rejected"), exchanges: ["rejected-code"] },
  ]) {
    const route = callback(scenario);
    const response = await route.GET(request("/dashboard", scenario.code));
    assert.equal(response.headers.get("location"), "https://tethoq.example/auth/sign-in?error=callback");
    assert.deepEqual(route.exchanges, scenario.exchanges);
  }
});
