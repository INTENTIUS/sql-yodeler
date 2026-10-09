import { ApplyOp } from "@intentius/chant/op";

export const { op } = ApplyOp({ name: "apply-e2e", env: "e2e", target: "postgres", gate: {} });
