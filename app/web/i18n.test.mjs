import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { DICT, register, getLang, t } from "./i18n.js";

const dir = new URL("./i18n/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));

test("default language is en with no param or storage", () => assert.equal(getLang(), "en"));

test("every dictionary has the same keys in en and es", async () => {
  assert.ok(files.includes("core.js"));
  for (const f of files) {
    const d = (await import(new URL(f, dir))).default, en = Object.keys(d.en ?? {}).sort(), es = Object.keys(d.es ?? {}).sort();
    assert.deepEqual(en, es, `${f}: en/es keys differ`);
    const lane = f.replace(".js", "");
    if (lane !== "core") for (const k of en) assert.ok(k.startsWith(`${lane}.`), `${f}: key "${k}" must start with "${lane}."`);
    register(d);
  }
  assert.equal(Object.keys(DICT.en).length, Object.keys(DICT.es).length);
});

test("no empty strings and t() falls back lang -> en -> key", () => {
  for (const l of ["en", "es"]) for (const [k, v] of Object.entries(DICT[l])) assert.ok(String(v).trim(), `${l}.${k} is empty`);
  assert.equal(t("no.such.key"), "no.such.key");
  assert.equal(t("route.value", { km: "1.2" }).includes("1.2"), true);
});
