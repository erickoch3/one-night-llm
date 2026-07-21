import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type CodexRuntimeSource =
  | "override"
  | "chatgpt-app"
  | "codex-app"
  | "path"
  | "common-install";

export interface CodexRuntime {
  executable: string;
  source: CodexRuntimeSource;
}

export interface CodexRuntimeDirectories {
  root: string;
  codexHome: string;
  nativeHome: string;
  workspace: string;
  credentials: string;
  configuration: string;
}

const forwardedEnvironmentKeys = [
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
] as const;

function uniqueCandidates(
  candidates: Array<{ executable: string; source: CodexRuntimeSource }>,
) {
  const seen = new Set<string>();
  return candidates.filter(({ executable }) => {
    if (seen.has(executable)) return false;
    seen.add(executable);
    return true;
  });
}

export async function locateCodexRuntime(): Promise<CodexRuntime | null> {
  const home = homedir();
  const candidates: CodexRuntime[] = [];
  const override = process.env.ONE_NIGHT_CODEX_EXECUTABLE?.trim();
  if (override) candidates.push({ executable: override, source: "override" });

  for (const appPath of [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(home, "Applications/ChatGPT.app/Contents/Resources/codex"),
  ]) {
    candidates.push({ executable: appPath, source: "chatgpt-app" });
  }
  for (const appPath of [
    "/Applications/Codex.app/Contents/Resources/codex",
    join(home, "Applications/Codex.app/Contents/Resources/codex"),
    "/Applications/Codex Beta.app/Contents/Resources/codex",
    join(home, "Applications/Codex Beta.app/Contents/Resources/codex"),
  ]) {
    candidates.push({ executable: appPath, source: "codex-app" });
  }

  for (const pathDirectory of (process.env.PATH ?? "").split(delimiter)) {
    if (pathDirectory) {
      candidates.push({
        executable: join(pathDirectory, "codex"),
        source: "path",
      });
    }
  }
  for (const commonPath of [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(home, ".local/bin/codex"),
    join(home, "bin/codex"),
  ]) {
    candidates.push({ executable: commonPath, source: "common-install" });
  }

  for (const candidate of uniqueCandidates(candidates)) {
    try {
      await access(candidate.executable, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking. An installed app may not include the runtime.
    }
  }
  return null;
}

function tomlString(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

/**
 * Ported from Discourse's CodexRuntime.swift. One Night keeps ChatGPT tokens in
 * an app-owned CODEX_HOME, and gives model turns an empty read-only workspace.
 */
export async function createCodexDirectories(): Promise<CodexRuntimeDirectories> {
  const root =
    process.env.ONE_NIGHT_CODEX_DATA_DIR?.trim() ||
    join(homedir(), "Library/Application Support/One Night LLM/Codex");
  const directories: CodexRuntimeDirectories = {
    root,
    codexHome: join(root, "codex-home"),
    nativeHome: join(root, "home"),
    workspace: join(root, "workspace"),
    credentials: join(root, "codex-home/auth.json"),
    configuration: join(root, "codex-home/config.toml"),
  };

  for (const directory of [
    directories.root,
    directories.codexHome,
    directories.nativeHome,
    directories.workspace,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  const safeRoot = tomlString(directories.root);
  const safeWorkspace = tomlString(directories.workspace);
  const safeHome = tomlString(directories.nativeHome);
  const configuration = `# Managed by One Night LLM. Do not broaden this model-driver boundary.
approval_policy = "never"
allow_login_shell = false
default_permissions = "one-night-model-driver"

[shell_environment_policy]
inherit = "none"
set = { PATH = "/usr/bin:/bin", HOME = "${safeHome}" }
ignore_default_excludes = false
include_only = ["PATH", "HOME", "TMPDIR"]

[permissions.one-night-model-driver.filesystem]
":minimal" = "read"
"${safeRoot}" = "deny"
"${safeWorkspace}" = "read"

[permissions.one-night-model-driver.network]
enabled = false
`;
  await writeFile(directories.configuration, configuration, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(directories.configuration, 0o600);
  return directories;
}

export async function secureCredentialFile(
  directories: CodexRuntimeDirectories,
) {
  try {
    await chmod(directories.credentials, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function codexProcessEnvironment(
  runtime: CodexRuntime,
  directories: CodexRuntimeDirectories,
) {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
  };
  for (const key of forwardedEnvironmentKeys) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  environment.PATH = [
    dirname(runtime.executable),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(delimiter);
  environment.CODEX_HOME = directories.codexHome;
  environment.HOME = directories.nativeHome;
  environment.TMPDIR = process.env.TMPDIR || tmpdir();
  return environment;
}

export const codexLaunchArguments = [
  "app-server",
  "-c",
  'cli_auth_credentials_store="file"',
  "--listen",
  "stdio://",
];
