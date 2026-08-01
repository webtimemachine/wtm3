import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDir = await mkdtemp(join(tmpdir(), "wtm-v4-additive-"));
const migrationsDir = join(temporaryDir, "migrations");

try {
  await mkdir(migrationsDir, { recursive: true });
  for (const name of [
    "0001_init.sql",
    "0002_beta_signups.sql",
    "0003_settings.sql",
    "0004_quota.sql",
    "0005_diagnostics.sql",
    "0006_v4_sessions.sql",
    "0008_extension_authorization.sql",
  ]) {
    await cp(
      join(backendDir, "migrations", name),
      join(migrationsDir, name),
    );
  }

  const config = JSON.parse(
    await readFile(join(backendDir, "wrangler.jsonc"), "utf8"),
  );
  config.main = join(backendDir, "src", "index.ts");
  config.d1_databases = config.d1_databases.map((database) =>
    database.binding === "DB"
      ? { ...database, migrations_dir: migrationsDir }
      : database,
  );
  delete config.$schema;
  const configPath = join(temporaryDir, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "wtm",
      "--remote",
      "--config",
      configPath,
    ],
    { cwd: backendDir, stdio: "inherit" },
  );
  const exitCode = await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
