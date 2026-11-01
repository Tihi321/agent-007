/** Small re-exports so the bake-off does not depend on the smoke scripts' internals by name. */
export { rawStream } from "../smoke/s6-stream-timeout.js";
export { withTimeout as withTimeoutCompat } from "../smoke/s2-roundtrip.js";
