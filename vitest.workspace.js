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
          wrangler: { configPath: "./wrangler.toml", environment: "test" },
          miniflare: {
            bindings: { ADMIN_PASSWORD: "test-pass", SESSION_SECRET: "test-secret", CREDENTIALS_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", AI_PROVIDER: "openai", AI_BASE_URL: "https://llm.test/v1", AI_API_KEY: "test-ai-key", GITHUB_TOKEN: "test-gh-token" }, // CREDENTIALS_KEY：测试用 32 字节密钥；AI_*：AI 助手走 OpenAI 兼容协议，出站请求由 fetchMock 拦截；GITHUB_TOKEN：反馈直接建 issue，api.github.com 同样由 fetchMock 拦截
            d1Databases: ["DB"],
          },
        },
      },
    },
  }),
]);
