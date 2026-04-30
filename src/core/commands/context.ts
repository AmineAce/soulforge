import { useUIStore } from "../../stores/ui.js";
import { icon } from "../icons.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

function openRepoMapMenu(_ctx: CommandContext): void {
  useUIStore.getState().openModal("repoMapStatus");
}

function openMemoryMenu(ctx: CommandContext): void {
  const memMgr = ctx.contextManager.getMemoryManager();

  const showMain = () => {
    const config = memMgr.scopeConfig;
    const hint = memMgr.cleanupHint();
    const cleanupDesc = hint
      ? `${String(hint.stale)} stale of ${String(hint.total)} memories — review now`
      : "review duplicates, dead file refs, stale entries";
    ctx.openCommandPicker({
      title: "Memory",
      icon: icon("memory"),
      options: [
        {
          value: "write-scope",
          label: "Write Scope",
          description: `where Forge saves new memories (current: ${config.writeScope})`,
        },
        {
          value: "read-scope",
          label: "Read Scope",
          description: `which memories Forge can access (current: ${config.readScope})`,
        },
        {
          value: "settings-storage",
          label: "Save Settings To",
          description: `where these scope preferences are stored (current: ${memMgr.settingsScope})`,
        },
        { value: "view", label: "View Memories", description: "browse / pin / delete entries" },
        {
          value: "cleanup",
          label: hint ? "Cleanup ★" : "Cleanup",
          description: cleanupDesc,
          color: hint ? getThemeTokens().warning : undefined,
        },
        { value: "clear", label: "Clear Memories", description: "permanently delete memories" },
      ],
      onSelect: (value) => {
        if (value === "write-scope") {
          ctx.openCommandPicker({
            title: "Write Scope",
            icon: icon("memory"),
            currentValue: memMgr.scopeConfig.writeScope,
            options: [
              {
                value: "global",
                label: "Global",
                description: "shared across all projects (~/.soulforge/)",
              },
              {
                value: "project",
                label: "Project",
                description: "scoped to this project (.soulforge/)",
              },
              { value: "none", label: "None", description: "Forge won't save new memories" },
            ],
            onSelect: (ws) => {
              memMgr.scopeConfig = {
                ...memMgr.scopeConfig,
                writeScope: ws as "global" | "project" | "none",
              };
              sysMsg(ctx, `Memory write scope: ${ws}`);
              showMain();
            },
          });
        } else if (value === "read-scope") {
          ctx.openCommandPicker({
            title: "Read Scope",
            icon: icon("memory"),
            currentValue: memMgr.scopeConfig.readScope,
            options: [
              {
                value: "all",
                label: "All",
                description: "search both project and global memories",
              },
              { value: "global", label: "Global", description: "only access global memories" },
              {
                value: "project",
                label: "Project",
                description: "only access this project's memories",
              },
              {
                value: "none",
                label: "None",
                description: "Forge won't read or auto-recall memories",
              },
            ],
            onSelect: (rs) => {
              memMgr.scopeConfig = {
                ...memMgr.scopeConfig,
                readScope: rs as "global" | "project" | "all" | "none",
              };
              sysMsg(ctx, `Memory read scope: ${rs}`);
              showMain();
            },
          });
        } else if (value === "settings-storage") {
          ctx.openCommandPicker({
            title: "Persist Settings",
            icon: icon("memory"),
            currentValue: memMgr.settingsScope,
            options: [
              {
                value: "project",
                label: "Project",
                description: "scope preferences saved in .soulforge/ (this project only)",
              },
              {
                value: "global",
                label: "Global",
                description: "scope preferences saved in ~/.soulforge/ (apply everywhere)",
              },
            ],
            onSelect: (ss) => {
              memMgr.setSettingsScope(ss as "project" | "global");
              sysMsg(ctx, `Memory settings saved to: ${ss}`);
              showMain();
            },
          });
        } else if (value === "view") {
          openMemoryBrowser(ctx, showMain);
        } else if (value === "cleanup") {
          openCleanupMenu(ctx, showMain);
        } else if (value === "clear") {
          ctx.openCommandPicker({
            title: "Clear Memories",
            icon: icon("memory"),
            options: [
              {
                value: "project",
                label: "Project",
                description: "delete all project-scoped memories",
              },
              { value: "global", label: "Global", description: "delete all global memories" },
              { value: "all", label: "All", description: "delete everything from both scopes" },
            ],
            onSelect: (scope) => {
              const cleared = memMgr.clearScope(scope as "project" | "global" | "all");
              sysMsg(ctx, `Cleared ${String(cleared)} ${scope} memories.`);
              showMain();
            },
          });
        }
      },
    });
  };

  showMain();
}

/**
 * Interactive memory list — select an entry to pin/unpin, soft-delete, or
 * restore. Soft-deleted memories are folded into the list when toggled
 * via the hidden filter.
 */
function openMemoryBrowser(ctx: CommandContext, onClose: () => void): void {
  const memMgr = ctx.contextManager.getMemoryManager();

  const show = (includeHidden: boolean) => {
    const memories = memMgr.list("all", { includeHidden });
    if (memories.length === 0) {
      sysMsg(ctx, includeHidden ? "No memories." : "No memories. (try Show Hidden)");
      onClose();
      return;
    }
    const options = memories.map((m) => {
      const cat = m.category ?? "—";
      const pin = m.pinned ? "★ " : "";
      const hidden = m.hidden ? " (hidden)" : "";
      return {
        value: `${m.scope}:${m.id}`,
        label: `${pin}[${m.scope}] ${cat}${hidden}`,
        description: m.summary,
        color: m.hidden ? getThemeTokens().textDim : undefined,
      };
    });
    ctx.openCommandPicker({
      title: includeHidden ? "Memories (incl. hidden)" : "Memories",
      icon: icon("memory"),
      options: [
        ...options,
        {
          value: "__toggle__",
          label: includeHidden ? "← Hide soft-deleted" : "→ Show soft-deleted",
          description: "",
        },
      ],
      onSelect: (value) => {
        if (value === "__toggle__") return show(!includeHidden);
        const sepIdx = value.indexOf(":");
        const scope = value.slice(0, sepIdx) as "project" | "global";
        const id = value.slice(sepIdx + 1);
        const record = memMgr.findById(scope, id);
        if (!record) {
          sysMsg(ctx, "Memory not found.");
          return show(includeHidden);
        }
        openMemoryActions(ctx, scope, id, record, () => show(includeHidden));
      },
    });
  };

  show(false);
}

function openMemoryActions(
  ctx: CommandContext,
  scope: "project" | "global",
  id: string,
  record: { pinned: boolean; hidden: boolean; summary: string; details: string },
  back: () => void,
): void {
  const memMgr = ctx.contextManager.getMemoryManager();
  ctx.openCommandPicker({
    title: record.summary.slice(0, 60),
    icon: icon("memory"),
    options: [
      ...(record.hidden
        ? [{ value: "restore", label: "Restore", description: "un-hide this memory" }]
        : [
            {
              value: record.pinned ? "unpin" : "pin",
              label: record.pinned ? "Unpin" : "Pin",
              description: record.pinned
                ? "remove from pinned set"
                : "exclude from cleanup suggestions",
            },
            {
              value: "delete",
              label: "Soft-delete",
              description: "hide from recall (restorable)",
            },
          ]),
      { value: "back", label: "← Back", description: "" },
    ],
    onSelect: (value) => {
      if (value === "pin") {
        memMgr.pin(scope, id);
        sysMsg(ctx, `Pinned ${id.slice(0, 8)}.`);
      } else if (value === "unpin") {
        memMgr.unpin(scope, id);
        sysMsg(ctx, `Unpinned ${id.slice(0, 8)}.`);
      } else if (value === "delete") {
        memMgr.softDelete(scope, id);
        sysMsg(ctx, `Soft-deleted ${id.slice(0, 8)} (restorable).`);
      } else if (value === "restore") {
        memMgr.restore(scope, id);
        sysMsg(ctx, `Restored ${id.slice(0, 8)}.`);
      }
      back();
    },
  });
}

function openCleanupMenu(ctx: CommandContext, onClose: () => void): void {
  const memMgr = ctx.contextManager.getMemoryManager();
  const cwd = ctx.cwd;

  const showCleanupRoot = () => {
    const hint = memMgr.cleanupHint();
    const tracker = memMgr.cleanupTracker;
    const lastLabel = tracker.lastCleanupAt
      ? `last run: ${tracker.lastCleanupAt.slice(0, 10)}`
      : "never run";
    ctx.openCommandPicker({
      title: "Memory Cleanup",
      icon: icon("memory"),
      options: [
        {
          value: "quick",
          label: "Quick",
          description: "find duplicate-content + dead-file-ref entries (no LLM)",
        },
        {
          value: "stale",
          label: "Stale",
          description: "show low-use, oldest entries for review (no LLM)",
        },
        {
          value: "back",
          label: "← Back",
          description: hint
            ? `${String(hint.sessions)} sessions since cleanup, ${lastLabel}`
            : lastLabel,
        },
      ],
      onSelect: (value) => {
        if (value === "quick") return runQuickCleanup();
        if (value === "stale") return runStaleCleanup();
        onClose();
      },
    });
  };

  const fileExists = (relPath: string): boolean => {
    try {
      return existsSync(join(cwd, relPath));
    } catch {
      return false;
    }
  };

  const runQuickCleanup = () => {
    const dupes = memMgr.findDuplicates("all");
    const dead = memMgr.findDeadFileRefs("all", fileExists);
    type Item = {
      kind: "dupe" | "dead";
      scope: "project" | "global";
      id: string;
      summary: string;
      detail: string;
    };
    const items: Item[] = [];
    for (const g of dupes) {
      for (const d of g.dupes) {
        items.push({
          kind: "dupe",
          scope: g.scope,
          id: d.id,
          summary: d.summary,
          detail: `dupe of ${g.kept.id.slice(0, 8)}`,
        });
      }
    }
    for (const d of dead) {
      items.push({
        kind: "dead",
        scope: d.scope,
        id: d.record.id,
        summary: d.record.summary,
        detail: `dead refs: ${d.deadPaths.slice(0, 2).join(", ")}${d.deadPaths.length > 2 ? "…" : ""}`,
      });
    }
    if (items.length === 0) {
      sysMsg(ctx, "Quick cleanup: nothing to do — no duplicates or dead refs found.");
      memMgr.noteCleanupCompleted();
      onClose();
      return;
    }
    showCandidates("Quick Cleanup", items);
  };

  const runStaleCleanup = () => {
    const stale = memMgr.staleCandidates("all", 25);
    if (stale.length === 0) {
      sysMsg(ctx, "Stale cleanup: no candidates.");
      memMgr.noteCleanupCompleted();
      onClose();
      return;
    }
    const items = stale.map((s) => ({
      kind: "stale" as const,
      scope: s.scope,
      id: s.record.id,
      summary: s.record.summary,
      detail: `${s.ageDays.toFixed(0)}d unused, ×${String(s.record.use_count)}`,
    }));
    showCandidates("Stale Cleanup", items);
  };

  const showCandidates = (
    title: string,
    items: Array<{
      kind: string;
      scope: "project" | "global";
      id: string;
      summary: string;
      detail: string;
    }>,
  ) => {
    if (items.length === 0) {
      sysMsg(ctx, `${title}: all reviewed.`);
      memMgr.noteCleanupCompleted();
      onClose();
      return;
    }
    const options = items.map((it) => ({
      value: `${it.scope}:${it.id}`,
      label: `[${it.scope}] ${it.summary.slice(0, 50)}`,
      description: `${it.kind} — ${it.detail}`,
    }));
    ctx.openCommandPicker({
      title: `${title} (${String(items.length)})`,
      icon: icon("memory"),
      options: [
        ...options,
        {
          value: "__finish__",
          label: "✓ Finish",
          description: "mark cleanup complete and exit",
        },
      ],
      onSelect: (value) => {
        if (value === "__finish__") {
          memMgr.noteCleanupCompleted();
          sysMsg(ctx, `${title}: marked complete.`);
          onClose();
          return;
        }
        const sep = value.indexOf(":");
        const scope = value.slice(0, sep) as "project" | "global";
        const id = value.slice(sep + 1);
        const item = items.find((i) => i.scope === scope && i.id === id);
        if (!item) return showCandidates(title, items);
        ctx.openCommandPicker({
          title: item.summary.slice(0, 60),
          icon: icon("memory"),
          options: [
            { value: "delete", label: "Soft-delete", description: "hide (restorable)" },
            { value: "pin", label: "Pin & keep", description: "exclude from future cleanups" },
            { value: "skip", label: "Skip", description: "leave as-is, remove from this list" },
            { value: "back", label: "← Back", description: "" },
          ],
          onSelect: (action) => {
            const remaining = items.filter((i) => !(i.scope === scope && i.id === id));
            if (action === "delete") {
              memMgr.softDelete(scope, id);
              sysMsg(ctx, `Deleted ${id.slice(0, 8)}.`);
              showCandidates(title, remaining);
            } else if (action === "pin") {
              memMgr.pin(scope, id);
              sysMsg(ctx, `Pinned ${id.slice(0, 8)}.`);
              showCandidates(title, remaining);
            } else if (action === "skip") {
              showCandidates(title, remaining);
            } else {
              showCandidates(title, items);
            }
          },
        });
      },
    });
  };

  showCleanupRoot();
}

function handleContextClear(input: string, ctx: CommandContext): void {
  const cmd = input.trim().toLowerCase();
  const what = cmd.includes("skills") ? "skills" : cmd.includes("memory") ? "memory" : "all";
  const cleared = ctx.contextManager.clearContext(what as "memory" | "skills" | "all");
  sysMsg(ctx, cleared.length > 0 ? `Cleared: ${cleared.join(", ")}` : "Nothing to clear.");
}

function handleContext(input: string, _ctx: CommandContext): void {
  const cmd = input.trim().toLowerCase();
  const tab = cmd.includes("dispatch")
    ? ("Dispatch" as const)
    : cmd.includes("system")
      ? ("System" as const)
      : ("Context" as const);
  useUIStore.setState({ statusDashboardTab: tab });
  useUIStore.getState().openModal("statusDashboard");
}

function handleDispatchStatus(_input: string, _ctx: CommandContext): void {
  useUIStore.setState({ statusDashboardTab: "Dispatch" });
  useUIStore.getState().openModal("statusDashboard");
}

function handleMemory(_input: string, ctx: CommandContext): void {
  openMemoryMenu(ctx);
}

function handleRepoMap(_input: string, ctx: CommandContext): void {
  openRepoMapMenu(ctx);
}

function handleTools(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("toolsPopup");
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/context", handleContext);
  map.set("/dispatch-status", handleDispatchStatus);
  map.set("/memory", handleMemory);
  map.set("/repo-map", handleRepoMap);
  map.set("/tools", handleTools);
}

export function matchContextPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("/context clear") || cmd === "/context reset") return handleContextClear;
  return null;
}
