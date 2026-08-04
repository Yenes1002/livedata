import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // ⚠️ REPLACE THIS with the project ref of YOUR OWN trigger.dev project.
  // Get it from the trigger.dev dashboard: your project -> Settings -> Project ref.
  // Do NOT leave someone else's ref here — deploying would replace their
  // deployment, and scheduled tasks only run for the latest deployment.
  project: "proj_nopopolmmnxtuibfnvqe",

  dirs: ["./trigger"],
  maxDuration: 1800, // 30 min ceiling per run

  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
});
