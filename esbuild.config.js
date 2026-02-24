import { build, context } from "esbuild";
import { join } from "path";
import { spawn } from "child_process";

const isDev = process.argv.includes("--dev") || process.argv.includes("--watch");
const pathToBuild = join(process.cwd(), "dist/main.cjs");

const buildOptions = {
  entryPoints: ["./src/main.ts"],
  bundle: true,
  outfile: pathToBuild,
  platform: "node",
  sourcemap: true,
  plugins: [],
};

let serverProcess = null;

async function startServer() {
  if (serverProcess) {
    console.log("🔄 Restarting server...");
    await serverProcess.kill();
    await new Promise((resolve) => {
      setTimeout(resolve, 100); // small delay to ensure the process has exited
    });
  } else {
    console.log("🚀 Starting server...");
  }

  serverProcess = spawn("node", [pathToBuild], {
    stdio: "inherit",
    env: process.env,
  });

  serverProcess.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.log(`❌ Server exited with code ${code}`);
    }
    serverProcess = null;
  });

  serverProcess.on("error", (err) => {
    console.error("❌ Failed to start server:", err);
    serverProcess = null;
  });
}

async function stopServer() {
  if (serverProcess) {
    console.log("🛑 Stopping server...");
    await serverProcess.kill();
    serverProcess = null;
  }
}

if (isDev) {
  // Create a build context for watching
  const ctx = await context({
    ...buildOptions,
    plugins: [
      ...buildOptions.plugins,
      {
        name: "restart-server",
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length === 0) {
              console.log("✅ Build completed");
              await startServer();
            } else {
              console.error("❌ Build failed:", result.errors);
            }
          });
        },
      },
    ],
  });

  // Start watching
  await ctx.watch();

  console.log("👀 Watching for changes...");
  console.log("Press Ctrl+C to stop");

  process.on("SIGINT", async () => {
    console.log("\n🛑 Shutting down...");
    await stopServer();
    ctx.dispose();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await stopServer();
    ctx.dispose();
    process.exit(0);
  });
} else {
  await build(buildOptions);
  console.log("✅ Build completed successfully");
}
