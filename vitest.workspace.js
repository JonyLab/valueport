import { defineWorkspace } from "vitest/config";
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

// vitest 2.1 uses a workspace file for multi-project setups (inline test.projects
// is a 3.x feature and is silently ignored on 2.1). Two projects:
//   core   — pure DOM-free logic, plain node environment
//   worker — Hono worker + helpers, Cloudflare pool-workers runtime (Web Crypto, D1, SELF)
export default defineWorkspace([
  {
    test: {
      name: "core",
      environment: "node",
      include: ["test-core/**/*.test.js"],
    },
  },
  defineWorkersProject({
    test: {
      name: "worker",
      include: ["test/**/*.test.js"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            bindings: { ADMIN_PASSWORD: "test-pass", SESSION_SECRET: "test-secret", CREDENTIALS_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" }, // CREDENTIALS_KEY：测试用 32 字节密钥
            d1Databases: ["DB"],
          },
        },
      },
    },
  }),
]);
