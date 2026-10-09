import { ApplyOp } from "@intentius/chant/op";

export const { op } = ApplyOp({ name: "apply-CLAIMENV", env: "CLAIMENV", target: "clickhouse", gate: {} });
