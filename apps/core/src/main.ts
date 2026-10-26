import { existsSync } from "node:fs";
import path from "node:path";
import { AnthropicModelClient } from "./model.js";
import { createCore } from "./server.js";

// Secrets come from the environment only. A local .env (git-ignored) is loaded if present.
const envFile = path.resolve(".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required environment variable ${name}. See apps/core/.env.example.`);
    process.exit(1);
  }
  return v;
}

const appToken = required("APP_TOKEN");
const apiKey = required("ANTHROPIC_API_KEY");
const modelName = required("MODEL_NAME");
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? "./workspace");
const dbFile = path.resolve(process.env.DB_FILE ?? "./ahmed-core.db");

// v0.2: cost accounting. Without BOTH prices the Core records tokens only and reports no cost.
const priceIn = process.env.MODEL_PRICE_INPUT_PER_1M ? Number(process.env.MODEL_PRICE_INPUT_PER_1M) : undefined;
const priceOut = process.env.MODEL_PRICE_OUTPUT_PER_1M ? Number(process.env.MODEL_PRICE_OUTPUT_PER_1M) : undefined;

const core = await createCore({
  dbFile,
  workspaceRoot,
  appToken,
  model: new AnthropicModelClient(apiKey, modelName),
  pricing: { inputPer1M: priceIn, outputPer1M: priceOut },
  logger: true,
});

await core.app.listen({ port, host });
console.log(`AHMED Core listening on http://${host}:${port}`);
console.log(`Workspace: ${core.workspace.root}`);
console.log(`Database:  ${dbFile}`);
console.log(`Model:     ${modelName}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void core.close().finally(() => process.exit(0));
  });
}
