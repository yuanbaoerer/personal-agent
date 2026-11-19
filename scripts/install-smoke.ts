import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { relative, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const keep = process.argv.includes("--keep");
const excludedTop = new Set([
  ".git",
  ".github",
  ".wrangler",
  "node_modules",
  "data",
  "backups",
  "exports",
  "coverage",
  "dist",
  "spikes",
]);
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli === undefined ? (process.platform === "win32" ? "npm.cmd" : "npm") : process.execPath;
const npmPrefix = npmCli === undefined ? [] : [npmCli];

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, [...npmPrefix, ...args], {
      cwd,
      env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.join(" ")} exited with ${code}`));
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address !== null && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (port === 0) throw new Error("could not allocate a free port");
  return port;
}

async function waitHealth(url: string, child: { exitCode: number | null; stderr: string }): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`service exited: ${child.stderr}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {
      // Retry while the service is starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`service did not become healthy: ${child.stderr}`);
}

async function startService(work: string): Promise<void> {
  const port = await freePort();
  let stderr = "";
  const child = spawn(process.execPath, ["apps/agent/src/main.ts"], {
    cwd: work,
    env: {
      ...process.env,
      FEISHU_APP_ID: "install-smoke-app",
      FEISHU_APP_SECRET: "install-smoke-secret",
      FEISHU_VERIFICATION_TOKEN: "install-smoke-token",
      FEISHU_EVENT_MODE: "webhook",
      OWNER_FEISHU_OPEN_ID: "ou_install_smoke",
      ADMIN_TOKEN: "install-smoke-admin",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: join(work, "data", "agent.sqlite"),
      PI_DATABASE_PATH: join(work, "data", "pi.sqlite"),
      OPENCODE_API_KEY: "",
      GITHUB_TOKEN: "",
      GITHUB_ALLOWED_REPOS: "",
      FEISHU_ENCRYPT_KEY: "",
      MAGPIE_URL: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const state = { exitCode: child.exitCode, stderr };
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    state.stderr = stderr;
  });
  child.once("exit", (code) => {
    state.exitCode = code;
  });
  try {
    await waitHealth(`http://127.0.0.1:${port}`, state);
    const status = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { authorization: "Bearer install-smoke-admin" },
    });
    if (!status.ok) throw new Error(`API health returned ${status.status}`);
    process.stdout.write(`service health: ok (port ${port})\n`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "pa-install-"));
  const work = join(temp, "repo");
  process.stdout.write(`install smoke: ${temp}\n`);
  try {
    await cp(root, work, {
      recursive: true,
      filter(source) {
        const rel = relative(root, source);
        if (rel === "") return true;
        const top = rel.split(sep)[0] ?? "";
        if (excludedTop.has(top)) return false;
        if (top === ".env" || (top.startsWith(".env.") && top !== ".env.example")) return false;
        if (rel.startsWith(`evals${sep}reports`)) return false;
        if (top.endsWith(".log") || top === ".DS_Store") return false;
        return true;
      },
    });
    await run(["ci", "--no-audit", "--no-fund"], work);
    await run(["run", "typecheck"], work);
    await run(["test"], work);
    await run(["exec", "node", "apps/agent/src/cli.ts", "help"], work);
    await startService(work);
    process.stdout.write("install smoke: all checks passed\n");
  } finally {
    if (keep) {
      process.stdout.write(`install smoke kept: ${temp}\n`);
    } else {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

await main();
