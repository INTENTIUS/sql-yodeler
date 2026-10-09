import { WatchOp } from "@intentius/chant/op";

// Every hour at :47, read prod as the reader and report drift. See
// watch-dev.op.ts.
export const { op } = WatchOp({ name: "watch-prod", env: "prod", schedule: "47 * * * *" });
