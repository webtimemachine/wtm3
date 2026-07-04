import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorageArea, makeFakeChrome } from "./fake-chrome.mjs";
import { loadBundle, makeFetch, page } from "./helpers.mjs";

const AUTH = { "wtm:state": { token: "tok", baseUrl: "https://api.test", user: { id: "u1", email: "u@x" }, captureEnabled: true } };

function happyRoutes(pushed) {
  return {
    "POST /nodes": (call) => ({ id: call.body.id, name: call.body.name, platform: call.body.platform }),
    "POST /sync/push": (call) => {
      pushed.push(call.body.pages.map((p) => p.id));
      return { accepted: call.body.pages.length, deleted: 0, seq: 1 };
    },
  };
}

async function boot(fake, routes) {
  const chromeObj = makeFakeChrome(fake);
  const fetchImpl = makeFetch(routes);
  await loadBundle("background", "chrome", chromeObj, { fetchImpl });
  const send = (msg) => chromeObj.runtime.sendMessage(msg);
  return { send, fetchImpl };
}

test("drains the queue in batches and clears it", async () => {
  const pushed = [];
  const fake = new FakeStorageArea({ seed: AUTH });
  const { send } = await boot(fake, happyRoutes(pushed));
  for (let i = 0; i < 75; i++) await send({ type: "capture", page: page(i) });
  await send({ type: "flushNow" });
  assert.equal(pushed.flat().length, 75, "every page pushed exactly once");
  assert.ok(pushed.length >= 2, "batched (50 cap)");
  const snap = fake.snapshot();
  assert.equal(snap["wtm:queue"]?.n ?? 0, 0, "queue drained");
  assert.ok(snap["wtm:state"].lastSync, "lastSync recorded");
  assert.equal(snap["wtm:state"].lastError, null);
});

test("stuck removal cannot head-of-line block: drain completes, no duplicate pushes in-run", async () => {
  const pushed = [];
  const fake = new FakeStorageArea({ seed: AUTH });
  const { send } = await boot(fake, happyRoutes(pushed));
  for (let i = 0; i < 60; i++) await send({ type: "capture", page: page(i) });

  // Sabotage queue-key writes only (removal can't stick), while state writes work.
  const origSet = fake.set.bind(fake);
  fake.set = async (obj) => {
    if ("wtm:queue" in obj) throw new Error("Exceeded storage quota.");
    return origSet(obj);
  };
  fake.removeFails = true; // brim escape blocked too — removal truly cannot stick

  await send({ type: "flushNow" });
  const allPushed = pushed.flat();
  assert.equal(new Set(allPushed).size, allPushed.length, "no page pushed twice within the run");
  assert.equal(allPushed.length, 60, "entire backlog drained despite removal never sticking");
});

test("clean drain heals the learned ceiling upward", async () => {
  const pushed = [];
  const fake = new FakeStorageArea({
    seed: { ...AUTH, "wtm:quotaCeiling": { bytes: 100_000, learnedAt: Date.now() } },
  });
  const { send } = await boot(fake, happyRoutes(pushed));
  await send({ type: "capture", page: page(1) });
  await send({ type: "flushNow" });
  const ceiling = fake.snapshot()["wtm:quotaCeiling"];
  assert.ok(ceiling.bytes > 100_000, `ceiling raised after clean drain (${ceiling.bytes})`);
});

test("401 drops the token but keeps deviceId/deviceOwner", async () => {
  const fake = new FakeStorageArea({
    seed: { "wtm:state": { ...AUTH["wtm:state"], deviceId: "node-1", deviceOwner: "https://api.test|u1" } },
  });
  const { send } = await boot(fake, {
    "POST /sync/push": { status: 401, json: { error: "unauthorized", message: "Missing or invalid token." } },
  });
  await send({ type: "capture", page: page(1) });
  await send({ type: "flushNow" });
  const st = fake.snapshot()["wtm:state"];
  assert.equal(st.token, null, "token dropped on 401");
  assert.equal(st.deviceId, "node-1", "node identity preserved for re-login");
  assert.match(st.lastError, /401/);
});
