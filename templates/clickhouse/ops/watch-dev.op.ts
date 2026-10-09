import { WatchOp } from "@intentius/chant/op";

// Every hour at :17, read dev as the reader and report drift: a declared
// object changed out of band, or gone. Objects src/ does not declare are
// never reported. CI runs it from .github/workflows/watch-dev.yml (and the
// Forgejo and GitLab equivalents), rendered by `npm run ci`.
export const { op } = WatchOp({ name: "watch-dev", env: "dev", schedule: "17 * * * *" });
