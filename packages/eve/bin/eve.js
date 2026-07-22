#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const packageNodeEngine = packageJson.engines?.node;
const bootstrapPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let semverPromise;

if (typeof packageNodeEngine !== "string") {
  throw new Error("eve package.json must declare a valid engines.node range.");
}

function createBootstrapOptions(overrides = {}) {
  const packageRoot = overrides.packageRoot ?? bootstrapPackageRoot;

  return {
    cliEntrypointPath:
      overrides.cliEntrypointPath ?? resolve(packageRoot, "dist", "src", "cli", "run.js"),
    packageRoot,
    postBuildScriptPaths: overrides.postBuildScriptPaths ?? [
      resolve(packageRoot, "scripts", "copy-compiled-assets.mjs"),
      resolve(packageRoot, "scripts", "copy-runtime-assets.mjs"),
      resolve(packageRoot, "scripts", "copy-docs.mjs"),
      resolve(packageRoot, "scripts", "stamp-version-tokens.mjs"),
    ],
    tscCliPath: overrides.tscCliPath,
  };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getPathMtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function getLatestDirectoryMtimeMs(path) {
  const stats = await stat(path);
  let latestMtimeMs = stats.mtimeMs;

  if (!stats.isDirectory()) {
    return latestMtimeMs;
  }

  const entries = await readdir(path, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const entryPath = resolve(path, entry.name);
    const entryLatestMtimeMs = await getLatestDirectoryMtimeMs(entryPath);

    if (entryLatestMtimeMs > latestMtimeMs) {
      latestMtimeMs = entryLatestMtimeMs;
    }
  }

  return latestMtimeMs;
}

async function getLatestBuildInputMtimeMs({ packageRoot }) {
  let latestMtimeMs = 0;

  for (const relativePath of ["src", "bin", "scripts"]) {
    const path = resolve(packageRoot, relativePath);
    const pathMtimeMs = await getPathMtimeMs(path);

    if (pathMtimeMs === undefined) {
      continue;
    }

    const latestPathMtimeMs = await getLatestDirectoryMtimeMs(path);

    if (latestPathMtimeMs > latestMtimeMs) {
      latestMtimeMs = latestPathMtimeMs;
    }
  }

  return latestMtimeMs;
}

async function canBuildWorkspaceCli({ exists, packageRoot, postBuildScriptPaths }) {
  for (const requiredPath of [
    resolve(packageRoot, "bin"),
    inputTsconfigPath({
      packageRoot,
    }),
    resolve(packageRoot, "src"),
    ...postBuildScriptPaths,
  ]) {
    if (!(await exists(requiredPath))) {
      return false;
    }
  }

  return true;
}

function inputTsconfigPath({ packageRoot }) {
  return resolve(packageRoot, "tsconfig.json");
}

function vendorCompiledScriptPath({ packageRoot }) {
  return resolve(packageRoot, "scripts", "vendor-compiled.mjs");
}

function generatedSemverPath({ packageRoot }) {
  return resolve(packageRoot, ".generated", "compiled", "semver", "index.js");
}

async function canBuildVendoredSemver({ exists, packageRoot }) {
  return await exists(vendorCompiledScriptPath({ packageRoot }));
}

function isModuleNotFoundError(error) {
  return typeof error === "object" && error !== null && error.code === "ERR_MODULE_NOT_FOUND";
}

async function loadVendoredSemver(options, dependencies = {}) {
  semverPromise ??= (async () => {
    const exists = dependencies.exists ?? fileExists;
    const executeCommand = dependencies.runCommand ?? runCommand;
    const importModule = dependencies.importBootstrapModule ?? ((specifier) => import(specifier));

    try {
      const module = await importModule("#compiled/semver/index.js");
      return module.default;
    } catch (error) {
      if (
        !isModuleNotFoundError(error) ||
        !(await canBuildVendoredSemver({ exists, packageRoot: options.packageRoot }))
      ) {
        throw error;
      }
    }

    const scriptPath = vendorCompiledScriptPath({
      packageRoot: options.packageRoot,
    });
    const semverPath = generatedSemverPath({
      packageRoot: options.packageRoot,
    });

    if (!(await exists(semverPath))) {
      await executeCommand(process.execPath, [scriptPath], {
        cwd: options.packageRoot,
      });
    }

    if (!(await exists(semverPath))) {
      throw new Error(`Building eve's vendored dependencies did not produce ${semverPath}.`);
    }

    const module = await importModule(pathToFileURL(semverPath).href);
    return module.default;
  })();

  return semverPromise;
}

async function assertSupportedNodeVersion(
  version = process.version,
  requiredRange = packageNodeEngine,
  options = createBootstrapOptions(),
  dependencies = {},
) {
  const semver = await loadVendoredSemver(options, dependencies);

  if (semver.validRange(requiredRange) === null) {
    throw new Error(`eve declares an invalid Node.js engine range: "${requiredRange}".`);
  }
  if (semver.satisfies(version, requiredRange)) {
    return;
  }

  throw new Error(
    [
      `eve requires Node.js ${requiredRange}.`,
      `You are running ${version}.`,
      "Please install a compatible Node.js version and try again.",
    ].join(" "),
  );
}

function resolveTscCliPath({ tscCliPath }) {
  if (tscCliPath) {
    return tscCliPath;
  }

  // The `typescript` package only exports `./package.json` in its `exports`
  // map, so `require.resolve("typescript/bin/tsc")`
  // fails with ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the package.json
  // (which is exported) and join to the binary path manually.
  const packageJsonPath = require.resolve("typescript/package.json");
  return resolve(dirname(packageJsonPath), "bin", "tsc");
}

async function runCommand(command, args, options) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
    });

    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }

      if (signal) {
        rejectCommand(new Error(`Command "${command}" exited due to signal ${signal}.`));
        return;
      }

      rejectCommand(new Error(`Command "${command}" exited with code ${code ?? "unknown"}.`));
    });
  });
}

/**
 * Ensures the compiled CLI entrypoint exists before the workspace bin is executed.
 */
export async function ensureBuiltCli(overrides = {}, dependencies = {}) {
  const options = createBootstrapOptions(overrides);
  const exists = dependencies.exists ?? fileExists;
  const getBuildInputMtimeMs =
    dependencies.getLatestBuildInputMtimeMs ?? getLatestBuildInputMtimeMs;
  const getEntrypointMtimeMs = dependencies.getPathMtimeMs ?? getPathMtimeMs;
  const executeCommand = dependencies.runCommand ?? runCommand;
  const packageCanBuildCli = await canBuildWorkspaceCli({
    exists,
    packageRoot: options.packageRoot,
    postBuildScriptPaths: options.postBuildScriptPaths,
  });

  if (await exists(options.cliEntrypointPath)) {
    if (!packageCanBuildCli) {
      return options.cliEntrypointPath;
    }

    const [latestBuildInputMtimeMs, cliEntrypointMtimeMs] = await Promise.all([
      getBuildInputMtimeMs({
        packageRoot: options.packageRoot,
      }),
      getEntrypointMtimeMs(options.cliEntrypointPath),
    ]);

    if (cliEntrypointMtimeMs !== undefined && cliEntrypointMtimeMs >= latestBuildInputMtimeMs) {
      return options.cliEntrypointPath;
    }
  }

  if (!packageCanBuildCli) {
    throw new Error(
      `eve package at ${options.packageRoot} does not include the sources required to rebuild the CLI.`,
    );
  }

  await executeCommand(
    process.execPath,
    [resolveTscCliPath({ tscCliPath: options.tscCliPath }), "-p", "tsconfig.json"],
    {
      cwd: options.packageRoot,
    },
  );
  for (const scriptPath of options.postBuildScriptPaths) {
    await executeCommand(process.execPath, [scriptPath], {
      cwd: options.packageRoot,
    });
  }

  if (await exists(options.cliEntrypointPath)) {
    return options.cliEntrypointPath;
  }

  throw new Error(`Building eve did not produce ${options.cliEntrypointPath}.`);
}

/**
 * Runs the compiled eve CLI, building the workspace package on demand when needed.
 */
export async function runEveCli(argv = process.argv.slice(2), overrides = {}, dependencies = {}) {
  const options = createBootstrapOptions(overrides);
  await assertSupportedNodeVersion(
    dependencies.nodeVersion,
    dependencies.nodeEngineRequirement,
    options,
    dependencies,
  );

  const cliEntrypointPath = await ensureBuiltCli(options, dependencies);
  const importModule = dependencies.importModule ?? ((specifier) => import(specifier));
  const cliModule = await importModule(pathToFileURL(cliEntrypointPath).href);

  if (typeof cliModule.runCli !== "function") {
    throw new Error(`The eve CLI module at ${cliEntrypointPath} does not export runCli().`);
  }

  await cliModule.runCli(argv);
}

async function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    const [currentPath, invokedPath] = await Promise.all([
      realpath(fileURLToPath(import.meta.url)),
      realpath(process.argv[1]),
    ]);

    return currentPath === invokedPath;
  } catch {
    return false;
  }
}

if (await isDirectExecution()) {
  try {
    await runEveCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    // Walk the `cause` chain so wrapped errors (sandbox prewarm wraps the
    // underlying Vercel SDK failure with remediation hints, etc.) still
    // surface the original SDK message a user can search for.
    let cause = error instanceof Error ? error.cause : undefined;
    while (cause instanceof Error) {
      console.error(`  Caused by: ${cause.message}`);
      cause = cause.cause;
    }
    process.exitCode = 1;
  } finally {
    installExitBackstop();
  }
}

/**
 * Once the top-level command resolves, the process should exit on its own as
 * the event loop drains. A command that leaves a handle alive (a leaked timer,
 * an unterminated worker, a wedged socket) would otherwise hang the terminal —
 * historically papered over by an unconditional `process.exit()` that masked
 * the leak. Instead, arm an unref'd deadline: a clean shutdown exits
 * immediately (the timer never holds the loop open), and only a genuine leak
 * trips the backstop, which reports the offending handles before forcing exit
 * so the regression is diagnosable rather than silent.
 */
function installExitBackstop() {
  const graceMs = Number(process.env.EVE_EXIT_BACKSTOP_MS ?? "2000");
  const backstop = setTimeout(
    () => {
      if (process.env.EVE_DEV_TRACE_EXIT?.trim()) {
        console.error(
          `[eve:dev] event loop did not drain within ${graceMs}ms; active resources: ${summarizeActiveResources()}`,
        );
      }
      process.exit(process.exitCode ?? 0);
    },
    Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 2000,
  );
  // The backstop must never itself keep the process alive.
  backstop.unref?.();
}

/** Counts the handles/requests still registered with the event loop, by kind. */
function summarizeActiveResources() {
  const info = process.getActiveResourcesInfo?.();
  if (info === undefined || info.length === 0) {
    return "none";
  }
  const counts = new Map();
  for (const resource of info) {
    counts.set(resource, (counts.get(resource) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
}
