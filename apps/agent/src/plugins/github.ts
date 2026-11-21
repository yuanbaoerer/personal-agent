import type { ActionTool } from "../actions/tooling.ts";
import { GitHubReadTool, type GitHubReadConfig } from "../actions/github.ts";
import { parsePluginManifest, type PluginManifest } from "./manifest.ts";
import type { BuiltinPlugin, PluginConnection } from "./types.ts";

const GITHUB_MANIFEST = parsePluginManifest({
  id: "github",
  name: "GitHub",
  version: "0.1.0",
  apiVersion: "1",
  trust: "builtin",
  entrypoint: "builtin:github-read",
  exports: {
    tools: ["github.read"],
    skills: [],
  },
  capabilities: [
    {
      name: "github.read",
      resource: "github",
      readOnly: true,
      replayPolicy: "verify",
      timeoutMs: 10_000,
      permissions: ["repository.read"],
      operations: [
        "repo",
        "commits",
        "issues",
        "pulls",
        "pull",
        "ref",
        "tree",
        "file",
        "issue",
        "pull_files",
        "checks",
      ],
      guidance:
        "GitHub receipts contain the API fields under previous action results. " +
        "For every issue/PR/commit field you state, add a githubClaim: " +
        '{"githubClaims":[{"kind":"github_item","repo":"owner/name","operation":"issues",' +
        '"item":"123","field":"state","value":"open"}]}. ' +
        "For typed file/tree/pull_files/checks facts, add kind=github_typed with " +
        "projectKey, operation, revision (commit or observed PR head SHA), target " +
        "(path, filename or check name), field and value. " +
        "Claims are checked against the matching receipt; omit unverifiable free text. " +
        "Typed ref/tree/file/issue/pull_files/checks require projectKey; the active owner ProjectBinding resolves the repository and must agree with any repo supplied.",
      description: "Read-only GitHub repository, issue, pull request and commit metadata.",
    },
  ],
  auth: ["pat", "oauth"],
  permissions: ["repository.read"],
  defaultPolicy: "enabled",
  config: {
    allowedReposEnv: "GITHUB_ALLOWED_REPOS",
    tokenEnv: "GITHUB_TOKEN",
  },
  description:
    "Builtin read-only integration. Connects through the existing PAT/OAuth credential path.",
});

/**
 * Wrap the already-verified GitHubReadTool. The plugin is enabled only when
 * the host can actually supply a token and an explicit repository allow list;
 * credentials stay behind tokenProvider and never enter the manifest.
 */
export function createGithubPlugin(config?: GitHubReadConfig): BuiltinPlugin {
  const allowedRepos = config?.allowedRepos ?? [];
  const hasCredential =
    config?.tokenProvider !== undefined ||
    (config?.token !== undefined && config.token.trim().length > 0);
  const configured = config !== undefined && hasCredential && allowedRepos.length > 0;
  const manifest: PluginManifest = GITHUB_MANIFEST;

  return {
    manifest,
    configured,
    createTools(): ActionTool[] {
      if (!configured || config === undefined) {
        throw new Error("GitHub plugin is not configured");
      }
      return [new GitHubReadTool(config)];
    },
    async connection(): Promise<PluginConnection> {
      if (allowedRepos.length === 0) {
        return { status: "unconfigured", detail: "no allowed repositories" };
      }
      if (!hasCredential || config === undefined) {
        return { status: "unconfigured", detail: "no PAT or OAuth connection" };
      }
      try {
        const token =
          config.tokenProvider === undefined
            ? config.token
            : await config.tokenProvider();
        if (token === undefined || token.trim().length === 0) {
          return { status: "unconfigured", detail: "connection is not logged in" };
        }
        return {
          status: "connected",
          scopes: ["repository.read"],
          detail: `${allowedRepos.length} allowed repository(s)`,
        };
      } catch {
        return { status: "error", detail: "credential lookup failed" };
      }
    },
  };
}

export const GITHUB_PLUGIN_ID = "github";
