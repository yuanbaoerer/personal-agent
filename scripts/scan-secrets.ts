import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface SecretRule {
  id: string;
  pattern: RegExp;
  /** Simpler expression for git log -G, which rejects some Perl groups. */
  historyPattern?: string;
}

export interface SecretFinding {
  rule: string;
  file: string;
  line: number;
}

export const SECRET_RULES: readonly SecretRule[] = [
  { id: "opencode_api_key", pattern: /oc_sk_[A-Za-z0-9_]{10,}/ },
  { id: "github_token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: "github_fine_grained_token", pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { id: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/ },
  {
    id: "private_key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/,
    historyPattern: "-----BEGIN [A-Z0-9 ]*PRIVATE KEY",
  },
  { id: "feishu_open_id", pattern: /ou_[0-9a-f]{20,}/ },
  { id: "feishu_app_id", pattern: /cli_[0-9a-f]{16,}/ },
  { id: "feishu_message_id", pattern: /om_[0-9a-z]{20,}/ },
  {
    id: "feishu_secret_assignment",
    pattern: /FEISHU_APP_SECRET\s*=\s*["']?[A-Za-z0-9]{20,}/,
    historyPattern: "FEISHU_APP_SECRET\\s*=\\s*[\"']?[A-Za-z0-9]",
  },
];

/** Return locations only; never include the matching value in output/logs. */
export function scanText(text: string, file = "<memory>"): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ rule: rule.id, file, line: index + 1 });
      }
    }
  }
  return findings;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file.length > 0);
}

function scanWorkingTree(): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of trackedFiles()) {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size > 5_000_000) {
      continue;
    }
    const content = readFileSync(file, "utf8");
    if (content.includes("\0")) {
      continue;
    }
    findings.push(...scanText(content, file));
  }
  return findings;
}

function scanHistory(): { rule: string; commits: string[] }[] {
  return SECRET_RULES.map((rule) => {
    let commits: string[] = [];
    try {
      commits = execFileSync(
        "git",
        [
          "log",
          "--all",
          "--perl-regexp",
          "--format=%H",
          `-G${rule.historyPattern ?? rule.pattern.source}`,
          "--",
          ".",
        ],
        { encoding: "utf8", maxBuffer: 10_000_000 },
      )
        .split("\n")
        .filter((line) => line.length > 0);
    } catch (error) {
      throw new Error(`git history scan failed for ${rule.id}`, { cause: error });
    }
    return { rule: rule.id, commits: [...new Set(commits)] };
  }).filter((entry) => entry.commits.length > 0);
}

const history = process.argv.includes("--history");
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  if (history) {
    const findings = scanHistory();
    console.log(
      JSON.stringify(
        {
          scope: "history",
          findings: findings.map((entry) => ({
            rule: entry.rule,
            commits: entry.commits,
            commitCount: entry.commits.length,
          })),
          note: "Locations only; matched values are intentionally not printed.",
        },
        null,
        2,
      ),
    );
    if (findings.length > 0) process.exitCode = 1;
  } else {
    const findings = scanWorkingTree();
    const summary = {
      scope: "working-tree",
      files: trackedFiles().length,
      findings,
      counts: Object.fromEntries(
        [...new Set(findings.map((finding) => finding.rule))].map((rule) => [
          rule,
          findings.filter((finding) => finding.rule === rule).length,
        ]),
      ),
      note: "Locations only; matched values are intentionally not printed.",
    };
    console.log(JSON.stringify(summary, null, 2));
    if (findings.length > 0) process.exitCode = 1;
  }
}
