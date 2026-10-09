// A project imports defineConfig from "@intentius/sql-yodeler"; this fixture
// is copied to a temporary directory where that package is not installed, so
// it exports the plain object defineConfig would return.
export default {
  environments: {
    single: { topology: "single", history: { database: "yodel_e2e_fixture_history" } },
    // The cluster the scratch containers declare (test/e2e/keeper-cluster.ts), so the databases are created on both replicas.
    replicated: { topology: "replicated:yodel", history: { database: "yodel_e2e_fixture_history" } },
  },
};
