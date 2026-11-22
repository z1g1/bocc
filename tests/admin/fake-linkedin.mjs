// A fake LinkedIn client for the use-case and HTTP tests (issue #18 "Testing
// Decisions"): the same seven operations as src/lib/linkedin/client.mjs, no network.
// Each call is recorded in `calls` ({ op, args }); canned replies mirror the CLI's
// tests (tools/linkedin-events/tests/test_cli.py, in git history). Queue a failure for the next call of
// an operation with fail(op, err), e.g. fail("createPost", new LinkedInError("validation", "x")).
import { LinkedInError } from "../../src/lib/linkedin/client.mjs";

export { LinkedInError };

/**
 * @param {{ accessToken?: string, expiresIn?: number, scope?: string,
 *           profile?: { memberUrn: string, name: string }, events?: object[] }} [opts]
 */
export function createFakeLinkedInClient(opts = {}) {
  const state = {
    accessToken: opts.accessToken ?? "AQV-fake-access-token",
    expiresIn: opts.expiresIn ?? 5_184_000, // 60 days
    scope: opts.scope ?? "r_events,rw_events,openid,profile,w_member_social",
    profile: opts.profile ?? { memberUrn: "urn:li:person:fakeMember1", name: "Fake Member" },
    events: opts.events ?? [],
  };
  const calls = [];
  const failures = new Map();

  const op = (name, fn) => async (...args) => {
    calls.push({ op: name, args });
    const queued = failures.get(name);
    if (queued?.length) throw queued.shift();
    return fn(...args);
  };

  return {
    calls,
    state,
    /** Make the next call of `name` throw `err`. */
    fail(name, err) {
      if (!failures.has(name)) failures.set(name, []);
      failures.get(name).push(err);
    },
    /** The ops called so far, in order. */
    ops: () => calls.map((c) => c.op),

    exchangeCode: op("exchangeCode", async () => ({ accessToken: state.accessToken, expiresIn: state.expiresIn, scope: state.scope })),
    getProfile: op("getProfile", async () => ({ ...state.profile })),
    initializeImageUpload: op("initializeImageUpload", async () => ({
      uploadUrl: "https://www.linkedin.com/dms-uploads/fake", imageUrn: "urn:li:image:D55", assetUrn: "urn:li:digitalmediaAsset:D55",
    })),
    uploadImage: op("uploadImage", async () => undefined),
    createEvent: op("createEvent", async () => ({ id: "7249812613549670400", vanityName: "buffaloopencoffeeclubfor10-67249812613549670400" })),
    createPost: op("createPost", async () => ({ postUrn: "urn:li:ugcPost:7511865991627468800" })),
    listOrganizerEvents: op("listOrganizerEvents", async () => state.events.map((e) => ({ ...e }))),
  };
}
