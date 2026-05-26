/**
 * Optional addons — components that are NOT bundled by default and that the
 * user explicitly fetches with `soulforge addon install <name>`.
 *
 * - proxy   → CLIProxyAPI (multi-provider LLM gateway, ~25 MB)
 * - neovim  → bundled Neovim (editor integration, ~15 MB)
 *
 * Install records live in AppConfig.addons. The presence of an entry with
 * `installed: true` is the source of truth — `getVendoredPath()` returning
 * null after that means the binary was manually removed, in which case we
 * treat the addon as gone and the user can reinstall.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveGlobalConfig } from "../../config/index.js";
import { logBackgroundError } from "../../stores/errors.js";
import { dataDir, EXE } from "../platform/index.js";
import { getVendoredPath, installNeovim, installProxy } from "./install.js";

export const ADDON_NAMES = ["proxy", "neovim"] as const;
export type AddonName = (typeof ADDON_NAMES)[number];

const BIN_DIR = join(dataDir(), "bin");
const INSTALLS_DIR = join(dataDir(), "installs");

/** Names of files under ${BIN_DIR} that addon-install creates. */
const ADDON_BIN: Record<AddonName, string> = {
  proxy: `cli-proxy-api${EXE}`,
  neovim: `nvim${EXE}`,
};

/** Filesystem prefix used by the existing install pipeline under `installs/`. */
const ADDON_INSTALL_PREFIX: Record<AddonName, string> = {
  proxy: "cliproxyapi-",
  neovim: "nvim-",
};

export interface AddonStatus {
  name: AddonName;
  installed: boolean;
  path?: string;
  version?: string;
  installedAt?: string;
}

/**
 * Source of truth for "is this addon installed". A config entry alone is not
 * enough — the binary must still exist on disk (covers manual cleanup +
 * pre-addon installs where the binary is present but config is silent).
 */
export function isAddonInstalled(name: AddonName): boolean {
  if (name === "proxy") return getVendoredPath("cli-proxy-api") !== null;
  if (name === "neovim") return getVendoredPath("nvim") !== null;
  return false;
}

export function listAddons(): AddonStatus[] {
  const cfg = loadConfig();
  return ADDON_NAMES.map((name) => {
    const record = cfg.addons?.[name];
    const installed = isAddonInstalled(name);
    const path = installed ? join(BIN_DIR, ADDON_BIN[name]) : undefined;
    return {
      name,
      installed,
      path,
      version: record?.version,
      installedAt: record?.installedAt,
    };
  });
}

type StatusCallback = (msg: string) => void;

export async function installAddon(name: AddonName, onStatus?: StatusCallback): Promise<void> {
  const log = (m: string) => onStatus?.(m);

  if (name === "proxy") {
    log("Installing CLIProxyAPI…");
    const { path, version } = await installProxy();
    recordInstall(name, version);
    log(`CLIProxyAPI v${version} installed at ${path}`);
    return;
  }

  if (name === "neovim") {
    log("Installing Neovim…");
    const path = await installNeovim();
    recordInstall(name);
    // Reset the palette nvim cache so editor commands surface immediately.
    try {
      const { resetNvimDetection } = await import("../commands/registry.js");
      resetNvimDetection();
    } catch {}
    log(`Neovim installed at ${path}`);
    return;
  }

  throw new Error(`Unknown addon: ${String(name)}`);
}

export async function removeAddon(name: AddonName, onStatus?: StatusCallback): Promise<void> {
  const log = (m: string) => onStatus?.(m);

  // Best-effort: kill any running instance so unlink doesn't EBUSY on Windows.
  if (name === "proxy") {
    try {
      const { stopProxy } = await import("../proxy/lifecycle.js");
      stopProxy();
    } catch {}
  }

  const binPath = join(BIN_DIR, ADDON_BIN[name]);
  if (existsSync(binPath)) {
    try {
      rmSync(binPath, { force: true });
    } catch (err) {
      logBackgroundError(
        "addons",
        `failed to remove ${binPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Remove every versioned install dir matching this addon's prefix.
  const prefix = ADDON_INSTALL_PREFIX[name];
  try {
    const { readdirSync } = await import("node:fs");
    if (existsSync(INSTALLS_DIR)) {
      for (const entry of readdirSync(INSTALLS_DIR)) {
        if (entry.startsWith(prefix)) {
          rmSync(join(INSTALLS_DIR, entry), { recursive: true, force: true });
        }
      }
    }
  } catch (err) {
    logBackgroundError(
      "addons",
      `failed to clean installs/ for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Clear config entry — preserves the other addon's record.
  const cfg = loadConfig();
  if (cfg.addons?.[name]) {
    const next = { ...cfg.addons };
    delete next[name];
    saveGlobalConfig({ addons: next });
  }
  if (name === "neovim") {
    try {
      const { resetNvimDetection } = await import("../commands/registry.js");
      resetNvimDetection();
    } catch {}
  }
  log(`Removed ${name} addon.`);
}

function recordInstall(name: AddonName, version?: string): void {
  const entry: { installed: true; version?: string; installedAt: string } = {
    installed: true,
    installedAt: new Date().toISOString(),
  };
  if (version) entry.version = version;
  saveGlobalConfig({ addons: { [name]: entry } });
}

/**
 * Parse and execute `soulforge addon <verb> <name?>`.
 * Returns the exit code to use for process.exit().
 */
export async function runAddonCli(args: string[]): Promise<number> {
  const verb = args[0];
  const target = args[1];

  if (!verb || verb === "list" || verb === "ls" || verb === "-l") {
    printList();
    return 0;
  }

  if (verb === "install" || verb === "add") {
    if (!target) {
      process.stderr.write(usage());
      return 1;
    }
    if (!isAddonName(target)) {
      process.stderr.write(`Unknown addon: ${target}\n${usage()}`);
      return 1;
    }
    try {
      await installAddon(target, (m) => process.stdout.write(`${m}\n`));
      return 0;
    } catch (err) {
      process.stderr.write(`Install failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (verb === "remove" || verb === "rm" || verb === "uninstall") {
    if (!target) {
      process.stderr.write(usage());
      return 1;
    }
    if (!isAddonName(target)) {
      process.stderr.write(`Unknown addon: ${target}\n${usage()}`);
      return 1;
    }
    try {
      await removeAddon(target, (m) => process.stdout.write(`${m}\n`));
      return 0;
    } catch (err) {
      process.stderr.write(`Remove failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (verb === "update" || verb === "upgrade") {
    if (!target) {
      process.stderr.write(usage());
      return 1;
    }
    if (!isAddonName(target)) {
      process.stderr.write(`Unknown addon: ${target}\n${usage()}`);
      return 1;
    }
    // Update = reinstall over the top.
    try {
      await installAddon(target, (m) => process.stdout.write(`${m}\n`));
      return 0;
    } catch (err) {
      process.stderr.write(`Update failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  process.stderr.write(usage());
  return 1;
}

function isAddonName(s: string): s is AddonName {
  return (ADDON_NAMES as readonly string[]).includes(s);
}

function printList(): void {
  const rows = listAddons();
  process.stdout.write("Addons\n");
  for (const r of rows) {
    const status = r.installed ? "installed" : "not installed";
    const ver = r.version ? ` v${r.version}` : "";
    process.stdout.write(`  ${r.name.padEnd(8)} ${status}${ver}\n`);
    if (r.installed && r.path) process.stdout.write(`           ${r.path}\n`);
  }
  process.stdout.write("\nUsage: soulforge addon <install|remove|update|list> [proxy|neovim]\n");
}

function usage(): string {
  return [
    "Usage: soulforge addon <install|remove|update|list> [proxy|neovim]",
    "",
    "  install proxy    download + activate CLIProxyAPI (~25 MB)",
    "  install neovim   download + activate Neovim (~15 MB)",
    "  remove <name>    uninstall the addon",
    "  update <name>    reinstall the addon (latest version)",
    "  list             show installed/available state",
    "",
  ].join("\n");
}

/**
 * CI / Docker hook: if `SOULFORGE_AUTO_INSTALL_ADDONS=proxy,neovim` is set,
 * silently install the listed addons that aren't already present.
 * Called from boot.tsx before any UI mounts. Failures are logged, not fatal.
 */
export async function autoInstallFromEnv(): Promise<void> {
  const raw = process.env.SOULFORGE_AUTO_INSTALL_ADDONS;
  if (!raw) return;
  const wanted = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(isAddonName);
  for (const name of wanted) {
    if (isAddonInstalled(name)) continue;
    try {
      await installAddon(name);
    } catch (err) {
      logBackgroundError(
        "addons",
        `auto-install ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
