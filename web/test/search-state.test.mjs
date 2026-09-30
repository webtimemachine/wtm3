import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// Compile the pure URL helpers using the existing TypeScript dependency.
const source = await readFile(new URL("../src/search-state.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { defaultSearchState, readSearchState, searchStateUrl, hasSearchFilters } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("reload restores a combined search, including an inclusive custom end date", () => {
  const state = {
    query: "Westinghouse W501B", site: "en.wikipedia.org", sort: "oldest",
    timePreset: "custom", customFrom: "2026-07-01", customTo: "2026-09-30",
  };
  const url = searchStateUrl(new URL("https://webtm.io/search?source=bookmark#results"), state);
  assert.deepEqual(readSearchState(url), state);
  assert.equal(url.searchParams.get("through"), "2026-09-30");
  assert.equal(url.searchParams.get("source"), "bookmark");
  assert.equal(url.hash, "#results");
});

test("keyword-free filter links and older q-only links restore correctly", () => {
  assert.deepEqual(readSearchState(new URL("https://webtm.io/search?q=W501B")), {
    ...defaultSearchState(), query: "W501B",
  });
  const state = { ...defaultSearchState(), site: "example.com", timePreset: "7d", sort: "newest" };
  assert.deepEqual(readSearchState(searchStateUrl(new URL("https://webtm.io/search"), state)), state);
  assert.equal(hasSearchFilters(state), true);
});

test("clearing filters retains the query and removes obsolete date parameters", () => {
  const current = new URL("https://webtm.io/search?q=Westinghouse&site=example.com&time=custom&from=2026-01-01&through=2026-02-01&sort=oldest");
  const cleared = { ...defaultSearchState(), query: "Westinghouse" };
  assert.equal(searchStateUrl(current, cleared).search, "?q=Westinghouse");
  assert.equal(hasSearchFilters(cleared), false);
  const preset = { ...cleared, timePreset: "today" };
  assert.equal(searchStateUrl(current, preset).searchParams.has("through"), false);
});

test("malformed bookmarked filter values fall back to usable controls", () => {
  const state = readSearchState(new URL("https://webtm.io/search?time=custom&from=2026-02-30&through=bad&sort=invalid"));
  assert.equal(state.customFrom, "");
  assert.equal(state.customTo, "");
  assert.equal(state.sort, "relevance");
  assert.equal(readSearchState(new URL("https://webtm.io/?time=invalid")).timePreset, "any");
});
