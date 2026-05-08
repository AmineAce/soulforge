#!/usr/bin/env bun
/**
 * Build script that uses Bun.build() JS API to enable the React Compiler
 * plugin during production builds. The CLI `bun build` does NOT support
 * plugins — only the JS API does.
 *
 * For --compile builds, this runs two phases:
 *   1. Bun.build() with React Compiler plugin → .build-tmp/soulforge.js
 *   2. Bun.build() compile on the pre-built JS → native binary
 * This works around Bun.build()'s compile mode ignoring the outfile option
 * and not supporting plugins.
 *
 * Usage:
 *   bun scripts/build.ts                                          — build to dist/
 *   bun scripts/build.ts --compile                                — build standalone binary
 *   bun scripts/build.ts --compile --outfile=path --target=bun-darwin-aarch64
 */
import { type BunPlugin } from "bun";
import { chmodSync, copyFileSync, cpSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ── Stub plugin for react-devtools-core (optional peer dep of @opentui/react) ──
// In compiled binaries there's no node_modules, so we replace the import with a no-op.
const devtoolsStubPlugin: BunPlugin = {
  name: "devtools-stub",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "devtools-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
      contents: "export default { connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

// ── Native addon loader for ghostty-opentui ──
// The .node native addon can't be embedded in compiled binaries.
// Replace the CJS loader with one that loads from ~/.soulforge/ at runtime.
const nativeAddonPlugin: BunPlugin = {
  name: "native-addon-loader",
  setup(build) {
    build.onLoad({ filter: /ghostty-opentui.*native-lib\.cjs$/ }, () => ({
      contents: `
const { platform, arch } = require("os");
const { join } = require("path");
const { homedir } = require("os");
function loadNativeModule() {
  const p = platform();
  const a = arch();
  const name = "ghostty-opentui.node";
  const paths = [
    join(homedir(), ".soulforge", "native", p + "-" + a, name),
    join(homedir(), ".soulforge", "bin", name),
  ];
  for (const path of paths) {
    try { return require(path); } catch {}
  }
  return null;
}
const native = loadNativeModule();
module.exports = { native };
`,
      loader: "js",
    }));
  },
};

// ── OpenTUI native lib resolver ──
// @opentui/core uses `import(`@opentui/core-${platform}-${arch}/index.ts`)`
// which fails in cross-compile because only the host platform's package is installed.
// Replace the platform index.ts with a runtime resolver that loads from ~/.soulforge/native/.
const opentuiNativePlugin: BunPlugin = {
  name: "opentui-native",
  setup(build) {
    build.onResolve({ filter: /^@opentui\/core-[a-z]+-[a-z0-9]+\/index\.ts$/ }, (args) => ({
      path: args.path,
      namespace: "opentui-native",
    }));
    build.onLoad({ filter: /.*/, namespace: "opentui-native" }, () => ({
      contents: `
import { homedir } from "os";
import { platform, arch } from "process";
import { join } from "path";
const ext = platform === "darwin" ? "dylib" : "so";
const libPath = join(homedir(), ".soulforge", "native", platform + "-" + arch, "libopentui." + ext);
export default libPath;
`,
      loader: "js",
    }));
  },
};

// ── React Compiler Plugin ────────────────────────────────────────────
const reactCompilerPlugin: BunPlugin = {
  name: "react-compiler",
  setup(build) {
    build.onLoad({ filter: /src\/.*\.tsx?$/ }, async ({ path, loader }) => {
      const { transformSync } = await import("@babel/core");
      const source = await Bun.file(path).text();
      const result = transformSync(source, {
        filename: path,
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
        parserOpts: { plugins: ["typescript", "jsx"] },
      });
      return { contents: result?.code ?? source, loader };
    });
  },
};

// ── Strip absolute filesystem paths from the bundle ────────────────────
// Bun's bundler may inline absolute paths (cwd, $HOME) into the bundle as
// __dirname / __filename strings or comment markers. Replace them so the
// dev machine's filesystem doesn't ship with the binary.
const stripAbsPathsPlugin: BunPlugin = {
  name: "strip-abs-paths",
  setup(build) {
    const cwd = process.cwd();
    const home = process.env.HOME ?? "";
    build.onLoad({ filter: /\.(ts|tsx|js|jsx)$/ }, async ({ path, loader }) => {
      let src = await Bun.file(path).text();
      if (cwd && src.includes(cwd)) src = src.split(cwd).join("");
      if (home && src.includes(home)) src = src.split(home).join("~");
      return { contents: src, loader };
    });
  },
};

// ── Parse args ───────────────────────────────────────────────────────
const isCompile = process.argv.includes("--compile");

const getFlag = (name: string) => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
};

const outfile = getFlag("outfile");
const compileTarget = getFlag("target");

// ── Build ────────────────────────────────────────────────────────────
const start = performance.now();

if (isCompile) {
  const tmpDir = ".build-tmp";

  // Phase 1: Build with React Compiler plugin → .build-tmp/soulforge.js
  // Using "soulforge" as the naming so Bun's compile derives "soulforge" as the binary name.
  const phase1 = await Bun.build({
    entrypoints: ["src/boot.tsx"],
    outdir: tmpDir,
    target: "bun",
    external: ["react-devtools-core"],
    naming: "soulforge.[ext]",
    plugins: [reactCompilerPlugin, nativeAddonPlugin, opentuiNativePlugin],
  });

  if (!phase1.success) {
    console.error("Phase 1 (React Compiler) failed:");
    for (const log of phase1.logs) console.error(log);
    process.exit(1);
  }

  // Patch: replace dynamic platform import that Bun can't statically resolve.
  // The template literal `import(`@opentui/core-${process.platform}-${process.arch}/index.ts`)`
  // passes through the bundler verbatim, then Phase 2 compile fails trying to resolve it.
  //
  // Self-heal: if libopentui.{so,dylib} is missing in ~/.soulforge/native/, attempt to
  // recover from the cellar/sibling deps/native/ tree before failing. If recovery fails,
  // throw a precise error pointing at the missing path + remediation, instead of the
  // misleading upstream "opentui is not supported on the current platform" message
  // (issue #66).
  {
    const bundlePath = `${tmpDir}/soulforge.js`;
    let src = await Bun.file(bundlePath).text();
    src = src.replace(
      /\w+ = await import\(`@opentui\/core-\$\{process\.platform\}-\$\{process\.arch\}\/index\.ts`\);\s*\w+ = \w+\.default;/,
      `targetLibPath = (() => {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const ext = process.platform === "darwin" ? "dylib" : "so";
  const triplet = process.platform + "-" + process.arch;
  const file = "libopentui." + ext;
  const home = path.join(os.homedir(), ".soulforge", "native", triplet, file);
  if (fs.existsSync(home)) return home;
  const candidates = [];
  try { candidates.push(path.resolve(path.dirname(process.execPath), "..", "deps", "native", triplet, file)); } catch {}
  try { candidates.push(path.resolve(path.dirname(process.execPath), "deps", "native", triplet, file)); } catch {}
  for (const src of candidates) {
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(home), { recursive: true });
        fs.copyFileSync(src, home);
        try { fs.chmodSync(home, 0o755); } catch {}
        return home;
      }
    } catch {}
  }
  const msg = "SoulForge native runtime missing: " + home + "\\n" +
    "  platform: " + triplet + "\\n" +
    "  fix: reinstall via 'brew reinstall soulforge' or rerun the install.sh from the release tarball.\\n" +
    "  if the problem persists, file an issue at https://github.com/proxysoul/soulforge/issues with this output.";
  throw new Error(msg);
})();`,
    );
    await Bun.write(bundlePath, src);
  }

  // Phase 2: Compile the pre-built JS into a native binary.
  // Bun.build() compile mode ignores outfile — it derives the binary name from
  // the entrypoint basename ("soulforge.js" → "./soulforge") and places it in cwd.
  const phase2 = await Bun.build({
    entrypoints: [`${tmpDir}/soulforge.js`],
    target: "bun",
    plugins: [devtoolsStubPlugin],
    compile: (compileTarget ?? true) as true,
  });

  if (!phase2.success) {
    console.error("Phase 2 (compile) failed:");
    for (const log of phase2.logs) console.error(log);
    process.exit(1);
  }

  rmSync(tmpDir, { recursive: true, force: true });

  // Binary lands at ./soulforge in cwd — move to outfile if specified
  const defaultBinary = resolve("soulforge");
  if (outfile) {
    const dest = resolve(outfile);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(defaultBinary, dest);
  }

  const elapsed = (performance.now() - start).toFixed(0);
  const finalPath = outfile ? resolve(outfile) : defaultBinary;
  console.log(`✓ Compiled binary with React Compiler in ${elapsed}ms → ${finalPath}`);
} else {
  // Production hardening: when NODE_ENV=production or --prod is passed, the
  // npm `dist/` build is minified, sourcemap-free, identifier-mangled.
  // This is what protects the published binary from `strings`-based source
  // recovery and casual reverse-engineering.
  const isProd = process.env.NODE_ENV === "production" || process.argv.includes("--prod");
  const minify = isProd ? { whitespace: true, identifiers: true, syntax: true } : false;

  const result = await Bun.build({
    entrypoints: ["src/boot.tsx"],
    outdir: "dist",
    target: "bun",
    naming: "[dir]/index.[ext]",
    plugins: [
      stripAbsPathsPlugin,
      reactCompilerPlugin,
      devtoolsStubPlugin,
    ],
    minify,
    sourcemap: "none",
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  // Build workers separately — npm installs need them as standalone files
  const workerResult = await Bun.build({
    entrypoints: [
      "src/core/workers/intelligence.worker.ts",
      "src/core/workers/io.worker.ts",
    ],
    outdir: "dist/workers",
    target: "bun",
    naming: "[name].[ext]",
    plugins: [reactCompilerPlugin],
    minify,
    sourcemap: "none",
  });

  if (!workerResult.success) {
    console.error("Worker build failed:");
    for (const log of workerResult.logs) console.error(log);
    process.exit(1);
  }

  // Copy runtime resources that can't be bundled inline.
  // opentui-assets: tree-sitter grammar WASMs + query files for markdown rendering.
  // init.lua: neovim configuration shipped with soulforge.
  // Parser worker is NOT pre-bundled — npm installs use the original from
  // @opentui/core in node_modules (set via OTUI_TREE_SITTER_WORKER_PATH in syntax.ts).
  copyFileSync("src/core/editor/init.lua", "dist/init.lua");
  cpSync("node_modules/@opentui/core/assets", "dist/opentui-assets", { recursive: true });

  // Shell wrapper that checks for bun before exec — gives a clear error to
  // npm/pnpm users who don't have bun installed.
  await Bun.write(
    "dist/bin.sh",
    '#!/bin/sh\n'
    + 'if ! command -v bun >/dev/null 2>&1; then\n'
    + '  echo "SoulForge requires Bun (https://bun.sh)" >&2\n'
    + '  echo "" >&2\n'
    + '  echo "Install Bun:" >&2\n'
    + '  echo "  curl -fsSL https://bun.sh/install | bash" >&2\n'
    + '  echo "" >&2\n'
    + '  echo "Then run: soulforge" >&2\n'
    + '  exit 1\n'
    + 'fi\n'
    + '# Resolve symlinks — follow chain (pnpm/bun can nest multiple levels)\n'
    + 'SELF="$0"\n'
    + 'while [ -L "$SELF" ]; do\n'
    + '  DIR="$(cd "$(dirname "$SELF")" && pwd)"\n'
    + '  SELF="$(readlink "$SELF")"\n'
    + '  case "$SELF" in /*) ;; *) SELF="$DIR/$SELF" ;; esac\n'
    + 'done\n'
    + 'exec bun "$(cd "$(dirname "$SELF")" && pwd)/index.js" "$@"\n',
  );
  chmodSync("dist/bin.sh", 0o755);

  // Production guards: assert no inline sourcemaps and no source-form sentinel
  // class declarations leak into the bundle. Bun preserves export NAMES even
  // with identifier mangling — the *class body* is what we protect.
  if (isProd) {
    const bundle = await Bun.file("dist/index.js").text();
    const sentinels = [
      /\bclass\s+ContextManager\b/,
      /\bclass\s+AgentBus\b/,
      /\bclass\s+RepoMap\b/,
      /\bclass\s+WorkspaceCoordinator\b/,
      /\bfunction\s+createForgeAgent\b/,
    ];
    const leaks = sentinels.filter((re) => re.test(bundle)).map((re) => re.source);
    if (leaks.length > 0) {
      console.error(`✗ unmangled class/function declarations leaked: ${leaks.join(", ")}`);
      process.exit(1);
    }
    if (bundle.includes("sourceMappingURL=data:")) {
      console.error("✗ inline sourcemap detected in bundle");
      process.exit(1);
    }
    // Post-build path scrub. The onLoad strip-paths plugin only sees our
    // source; pre-bundled CJS deps inline absolute __dirname/__filename paths
    // that survive into dist/index.js. Replace them.
    const cwd = process.cwd();
    const home = process.env.HOME ?? "";
    let raw = bundle;
    for (const needle of [cwd, home].filter(Boolean)) {
      if (raw.includes(needle)) raw = raw.split(needle).join("");
    }
    if (raw !== bundle) {
      await Bun.write("dist/index.js", raw);
    }
    console.log("✓ verified: sentinels absent, no inline sourcemap, paths stripped");
  }

  const elapsed = (performance.now() - start).toFixed(0);
  const count = result.outputs.length + workerResult.outputs.length;
  console.log(
    `✓ Built ${count} artifact${count === 1 ? "" : "s"} with React Compiler in ${elapsed}ms (minified=${!!minify})`,
  );
}
