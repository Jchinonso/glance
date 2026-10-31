import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(`${readFileSync(new URL("../src/ui/onboarding.js", import.meta.url), "utf8")}\nthis.f = { onboardingSteps, stepLabel, shouldAskJob };`, ctx);
const { onboardingSteps, stepLabel, shouldAskJob } = ctx.f;
const steps = (o) => [...onboardingSteps(o)];

test("setup steps: fresh install asks for a key and, for interviews, the job description", () => {
  assert.deepEqual(steps({ needsKey: true, use: "interviews" }), ["welcome", "key", "about", "job", "ready"]);
  assert.deepEqual(steps({ needsKey: true, use: "both" }), ["welcome", "key", "about", "job", "ready"]);
});

test("setup steps: a saved key is skipped; meetings only skips the job description", () => {
  assert.deepEqual(steps({ needsKey: false, use: "interviews" }), ["welcome", "about", "job", "ready"]);
  assert.deepEqual(steps({ needsKey: false, use: "meetings" }), ["welcome", "about", "ready"]);
  assert.deepEqual(steps({ needsKey: true, use: "meetings" }), ["welcome", "key", "about", "ready"]);
});

test("step labels count setup steps, not the welcome", () => {
  const s = onboardingSteps({ needsKey: true, use: "interviews" });
  assert.equal(stepLabel(s, "welcome"), "");
  assert.equal(stepLabel(s, "key"), "Step 1 of 4");
  assert.equal(stepLabel(s, "ready"), "Step 4 of 4");
});

test("job description: asked at each interview, not again within 30 minutes", () => {
  const now = 10 * 60 * 60 * 1000;
  assert.ok(shouldAskJob({ style: "interview", jdCheckedAt: 0, now })); // never confirmed, or session cleared
  assert.ok(!shouldAskJob({ style: "interview", jdCheckedAt: now - 10 * 60 * 1000, now })); // restart 10 min in
  assert.ok(shouldAskJob({ style: "interview", jdCheckedAt: now - 60 * 60 * 1000, now })); // next interview an hour later
  assert.ok(!shouldAskJob({ style: "brief", jdCheckedAt: 0, now })); // not in Interview mode
});
