import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";

import {
  SCENARIOS,
  SCENARIO_COUNTS,
  validateCatalog,
  type ScenarioCategory,
  type ScenarioDefinition,
} from "../evals/scenarios.ts";

type ResultStatus = "passed" | "failed" | "pending" | "skipped";

interface ScenarioResult {
  scenario: ScenarioDefinition;
  status: ResultStatus;
  durationMs: number;
  command?: string;
  exitCode?: number;
  outputTail?: string;
  reason?: string;
}

interface ReportTotals {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  executed: number;
}

const args = new Set(process.argv.slice(2));
const shouldRun = args.has("--run");
const criticalOnly = args.has("--critical");
const outIndex = process.argv.indexOf("--out");
const outDir = resolve(
  outIndex === -1 ? "evals/reports" : (process.argv[outIndex + 1] ?? "evals/reports"),
);

function git(args: string[], fallback = "unknown"): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function packageVersions(): Record<string, unknown> {
  const root = JSON.parse(readFileSync("package.json", "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const agent = existsSync("apps/agent/package.json")
    ? (JSON.parse(readFileSync("apps/agent/package.json", "utf8")) as {
        dependencies?: Record<string, string>;
      })
    : {};
  return {
    rootDevDependencies: root.devDependencies ?? {},
    agentDependencies: agent.dependencies ?? {},
    node: process.version,
  };
}

function runScenario(scenario: ScenarioDefinition): ScenarioResult {
  if (scenario.pending !== undefined) {
    return { scenario, status: "pending", durationMs: 0, reason: scenario.pending };
  }
  if (!shouldRun) {
    return { scenario, status: "skipped", durationMs: 0, reason: "pass --run to execute" };
  }
  if (criticalOnly && !scenario.critical) {
    return { scenario, status: "skipped", durationMs: 0, reason: "filtered by --critical" };
  }
  const test = scenario.test;
  if (test === undefined) {
    return { scenario, status: "failed", durationMs: 0, reason: "missing test reference" };
  }
  if (!existsSync(test.file)) {
    return {
      scenario,
      status: "failed",
      durationMs: 0,
      reason: `test file not found: ${test.file}`,
    };
  }
  if (!readFileSync(test.file, "utf8").includes(test.name)) {
    return {
      scenario,
      status: "failed",
      durationMs: 0,
      reason: `test name not found in ${test.file}: ${test.name}`,
    };
  }
  const command = [
    "--test",
    `--test-name-pattern=^${escapePattern(test.name)}$`,
    test.file,
  ];
  const started = performance.now();
  const result = spawnSync(process.execPath, command, {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, NODE_ENV: "test" },
  });
  const durationMs = Math.round(performance.now() - started);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const passed =
    result.status === 0 && /(?:^|\n)\s*ℹ pass [1-9]\d*/m.test(output);
  return {
    scenario,
    status: passed ? "passed" : "failed",
    durationMs,
    command: `${process.execPath} ${command.join(" ")}`,
    exitCode: result.status ?? -1,
    outputTail: passed ? undefined : output.slice(-4_000),
    reason: passed
      ? undefined
      : result.error?.message ?? "test failed or did not match exactly one case",
  };
}

function totals(results: readonly ScenarioResult[]): ReportTotals {
  const count = (status: ResultStatus) =>
    results.filter((result) => result.status === status).length;
  const passed = count("passed");
  const failed = count("failed");
  return {
    total: results.length,
    passed,
    failed,
    pending: count("pending"),
    skipped: count("skipped"),
    executed: passed + failed,
  };
}

function categoryTotals(results: readonly ScenarioResult[]) {
  return Object.fromEntries(
    (Object.keys(SCENARIO_COUNTS) as ScenarioCategory[]).map((category) => {
      const subset = results.filter((result) => result.scenario.category === category);
      return [category, totals(subset)];
    }),
  ) as Record<ScenarioCategory, ReportTotals>;
}

function kCoverage(results: readonly ScenarioResult[]) {
  const coverage: Record<string, { status: string; scenarios: string[] }> = {};
  for (let index = 1; index <= 14; index += 1) {
    const key = `K${String(index).padStart(2, "0")}`;
    const subset = results.filter((result) => result.scenario.k.includes(key));
    const statuses = new Set(subset.map((result) => result.status));
    const status =
      subset.length === 0
        ? "not_covered"
        : statuses.has("failed")
          ? "failed"
          : statuses.has("pending")
            ? "pending"
            : statuses.has("skipped")
              ? "skipped"
              : "passed";
    coverage[key] = {
      status,
      scenarios: subset.map((result) => result.scenario.id),
    };
  }
  return coverage;
}

function markdown(
  report: Record<string, unknown>,
  results: readonly ScenarioResult[],
): string {
  const totalsValue = report.totals as ReportTotals;
  const categories = report.categories as Record<ScenarioCategory, ReportTotals>;
  const coverage = report.kCoverage as Record<string, { status: string; scenarios: string[] }>;
  const lines = [
    "# Personal Agent evaluation report",
    "",
    `- Commit: \`${String(report.commitSha)}\`${report.dirty ? " (dirty)" : ""}`,
    `- Generated: ${String(report.generatedAt)}`,
    `- Environment: ${String((report.environment as Record<string, unknown>).platform)}/${String((report.environment as Record<string, unknown>).arch)}, Node ${String((report.environment as Record<string, unknown>).node)}`,
    `- Catalog: ${String(report.catalogVersion)}`,
    `- Real model: ${String((report.realModel as Record<string, unknown>).status)} (${String((report.realModel as Record<string, unknown>).reason)})`,
    "",
    "## Totals",
    "",
    "| Total | Executed | Passed | Failed | Pending | Skipped |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${totalsValue.total} | ${totalsValue.executed} | ${totalsValue.passed} | ${totalsValue.failed} | ${totalsValue.pending} | ${totalsValue.skipped} |`,
    "",
    "Pending scenarios are excluded from the success denominator. They are not passes.",
    "",
    "## Categories",
    "",
    "| Category | Total | Executed | Passed | Failed | Pending |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(categories).map(
      ([name, value]) =>
        `| ${name} | ${value.total} | ${value.executed} | ${value.passed} | ${value.failed} | ${value.pending} |`,
    ),
    "",
    "## K01–K14 coverage",
    "",
    "| Key | Status | Scenarios |",
    "| --- | --- | --- |",
    ...Object.entries(coverage).map(
      ([key, value]) => `| ${key} | ${value.status} | ${value.scenarios.join(", ")} |`,
    ),
    "",
    "## Scenarios",
    "",
    "| ID | Category | K | Env | Mock/Real | Status | ms | Reason |",
    "| --- | --- | --- | --- | --- | --- | ---: | --- |",
    ...results.map((result) => {
      const scenario = result.scenario;
      return `| ${scenario.id} | ${scenario.category} | ${scenario.k.join(",") || "-"} | ${scenario.environmentLevel} | ${scenario.mockOrReal} | ${result.status} | ${result.durationMs} | ${(result.reason ?? "").replace(/\|/g, "\\|").slice(0, 180)} |`;
    }),
    "",
    "## Failures",
    "",
    ...(results
      .filter((result) => result.status === "failed")
      .flatMap((result) => [
        `### ${result.scenario.id}`,
        "",
        "```text",
        (result.outputTail ?? result.reason ?? "unknown failure").slice(-3_000),
        "```",
        "",
      ])),
    ...(results.some((result) => result.status === "failed")
      ? []
      : ["None.", ""]),
    "## Unimplemented real evidence",
    "",
    report.pendingNote as string,
    "",
  ];
  return lines.join("\n");
}

const catalogErrors = validateCatalog();
if (catalogErrors.length > 0) {
  console.error(catalogErrors.join("\n"));
  process.exit(2);
}

const results = SCENARIOS.map(runScenario);
const totalsValue = totals(results);
const commitSha = git(["rev-parse", "HEAD"]);
const dirty = git(["status", "--porcelain"]).length > 0;
const generatedAt = new Date().toISOString();
const report = {
  schemaVersion: 1,
  generatedAt,
  commitSha,
  dirty,
  catalogVersion: "evals/scenarios.ts v1",
  environment: {
    platform: platform(),
    arch: arch(),
    node: process.version,
    ci: process.env.CI === "true",
    model: process.env.EVAL_MODEL ?? null,
    modelParameters: process.env.EVAL_MODEL_PARAMS ?? null,
  },
  dependencies: packageVersions(),
  totals: totalsValue,
  categories: categoryTotals(results),
  kCoverage: kCoverage(results),
  realModel: {
    status: "pending",
    requiredTasks: 10,
    requiredRunsPerTask: 3,
    executedRuns: 0,
    reason: "requires an explicit paid-model/credential decision and budget",
  },
  pendingNote:
    "The 40-scenario catalog is deterministic-contract coverage only. G1–G3 E3, 10 real-model tasks ×3, 7-day self-use, real Feishu/GitHub/Cloudflare recovery, and release approval remain pending. Pending scenarios are excluded from the success denominator.",
  scenarios: results.map((result) => ({
    id: result.scenario.id,
    version: result.scenario.version,
    category: result.scenario.category,
    critical: result.scenario.critical,
    k: result.scenario.k,
    environmentLevel: result.scenario.environmentLevel,
    mockOrReal: result.scenario.mockOrReal,
    preconditions: result.scenario.preconditions,
    inputSequence: result.scenario.inputSequence,
    faultInjectionPoint: result.scenario.faultInjectionPoint,
    expectedDbState: result.scenario.expectedDbState,
    expectedExternalState: result.scenario.expectedExternalState,
    expectedNotifications: result.scenario.expectedNotifications,
    traceLinks: result.scenario.traceLinks,
    test: result.scenario.test,
    status: result.status,
    durationMs: result.durationMs,
    command: result.command,
    exitCode: result.exitCode,
    reason: result.reason,
    failureOutput: result.outputTail,
  })),
};

mkdirSync(outDir, { recursive: true });
const stamp = generatedAt.replace(/[:.]/g, "-");
const base = join(outDir, `${stamp}-${commitSha.slice(0, 7)}`);
const jsonPath = `${base}.json`;
const mdPath = `${base}.md`;
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  mdPath,
  markdown(report as unknown as Record<string, unknown>, results),
);
console.log(`wrote ${jsonPath}`);
console.log(`wrote ${mdPath}`);
console.log(
  `scenarios=${totalsValue.total} executed=${totalsValue.executed} passed=${totalsValue.passed} failed=${totalsValue.failed} pending=${totalsValue.pending} skipped=${totalsValue.skipped}`,
);
if (totalsValue.failed > 0) {
  process.exit(1);
}
