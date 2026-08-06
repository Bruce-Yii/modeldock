// "Auto - free first" routing.
//
// A synthetic model the Codex picker can select. Requests for it go to the free model
// first and fall back to the paid one when the free upstream fails, transparently: the
// retry happens before any byte reaches the client, so a downgrade looks like a slightly
// slower first token rather than an error.
//
// Falling back on *every* upstream failure is deliberate - the free tier's
// quota-exhausted response shape is not documented, so pattern-matching it would risk
// surfacing an error we could have absorbed. What the error type does decide is whether
// the downgrade *sticks*: a 4xx (quota, auth, rejected request) parks the session on the
// paid model for a cooldown, while a 5xx or a network blip only affects the one request.
// Otherwise a single transient upstream hiccup would spend an hour of paid quota.

export const AUTO_FREE_MODEL_ID = "auto-free-first";
export const AUTO_FREE_LABEL = "Auto - DeepSeek Free first";

const FREE_MODEL = "deepseek-v4-flash-free";
const PAID_MODEL = "deepseek-v4-flash";
const COOLDOWN_MS = 60 * 60_000;

export function createAutoRoute({ freeModel = FREE_MODEL, paidModel = PAID_MODEL, cooldownMs = COOLDOWN_MS, now = () => Date.now() } = {}) {
  let downgradedUntil = 0;
  let lastReason = "";

  const downgraded = () => downgradedUntil > now();

  return {
    freeModel,
    paidModel,
    /** The model an auto-routed request should try first. */
    preferred() {
      return downgraded() ? paidModel : freeModel;
    },
    /** The model to retry with, or null when there is nothing left to try. */
    fallbackFor(model) {
      return model === freeModel ? paidModel : null;
    },
    /**
     * Record a failure of the free upstream. 4xx parks the session on the paid model
     * for the cooldown; anything else (5xx, network) is treated as transient.
     */
    recordFailure({ status, error } = {}) {
      const sticky = Number.isInteger(status) && status >= 400 && status < 500;
      if (sticky) {
        downgradedUntil = now() + cooldownMs;
        lastReason = `HTTP ${status}`;
      } else {
        lastReason = status ? `HTTP ${status} (transient)` : `${error || "request failed"} (transient)`;
      }
      return { sticky, until: downgradedUntil };
    },
    /** Dashboard-facing state; the gate never hides which model is actually serving. */
    state() {
      const active = downgraded();
      return {
        model: AUTO_FREE_MODEL_ID,
        using: active ? paidModel : freeModel,
        downgraded: active,
        cooldownMsRemaining: active ? downgradedUntil - now() : 0,
        reason: lastReason,
      };
    },
  };
}
