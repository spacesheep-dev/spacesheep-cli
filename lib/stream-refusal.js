"use strict";

// Shared by value streams, camera streams and their service templates. Auth keeps
// exit 3; a plan refusal has its own status so a supervisor can leave it stopped.
const PLAN_REQUIRED_EXIT = 4;

function permanentRefusal(res, body, video = false) {
  // Current servers send { code, error: human text }. Also accept the code in
  // `error`, without trying to infer an entitlement from prose or HTTP status.
  if (body?.code === "plan_required" || body?.error === "plan_required") {
    const need = video
      ? "filming requires Pro (1 camera) or Max/Team (5 cameras)"
      : "sending live values requires the Max plan";
    return { exitCode: PLAN_REQUIRED_EXIT, message: `plan_required: ${need} — https://spacesheep.dev/plans; this will not be retried.` };
  }
  if (res.status === 401 || res.status === 403) {
    return { exitCode: 3, message: body?.error || `the server refused the key (HTTP ${res.status})` };
  }
  return null;
}

module.exports = { permanentRefusal, PLAN_REQUIRED_EXIT };
