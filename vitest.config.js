import { defineConfig } from "vitest/config";
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineConfig({
  test: {
    projects: [
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
                bindings: { ADMIN_PASSWORD: "test-pass", SESSION_SECRET: "test-secret" },
                d1Databases: ["DB"],
              },
            },
          },
        },
      }),
    ],
  },
});
