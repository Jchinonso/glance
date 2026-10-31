// Loaded before app.js as a plain script (its functions become globals).

// Setup steps, in order. "welcome" comes first; the key step only when there's
// no working key; the job description step only for interviews.
function onboardingSteps({ needsKey, use }) {
  return ["welcome", ...(needsKey ? ["key"] : []), "about", ...(use === "meetings" ? [] : ["job"]), "ready"];
}

// "Step 2 of 4" for a setup step; the welcome screen isn't counted.
function stepLabel(steps, step) {
  const counted = steps.filter((s) => s !== "welcome");
  const i = counted.indexOf(step);
  return i < 0 ? "" : `Step ${i + 1} of ${counted.length}`;
}

// Ask "Same role, or a new job description?" at the start of each interview:
// when Interview mode is on, unless it was answered in the last 30 minutes
// (a restart within the same interview). Clear session resets it.
const JOB_RECHECK_MS = 30 * 60 * 1000;
function shouldAskJob({ style, jdCheckedAt, now }) {
  return style === "interview" && now - (jdCheckedAt || 0) > JOB_RECHECK_MS;
}
