import type { ModelMessage } from "ai";
import type { SessionMeta, TabMeta } from "../core/sessions/types.js";
import { useCheckpointStore } from "../stores/checkpoints.js";
import { useUIStore } from "../stores/ui.js";
import type { ChatMessage } from "../types/index.js";
import type { WorkspaceSnapshot } from "./useChat.js";

interface BuildParams {
  sessionId: string;
  title: string;
  customTitle?: string | null;
  cwd: string;
  snapshot: WorkspaceSnapshot;
  currentTabMessages: ChatMessage[];
  currentTabCoreMessages?: ModelMessage[];
}

export function buildSessionMeta({
  sessionId,
  title,
  customTitle,
  cwd,
  snapshot,
  currentTabMessages,
  currentTabCoreMessages,
}: BuildParams): {
  meta: SessionMeta;
  tabMessages: Map<string, ChatMessage[]>;
  tabCoreMessages: Map<string, ModelMessage[]>;
} {
  const tabMessages = new Map<string, ChatMessage[]>();
  const tabCoreMessages = new Map<string, ModelMessage[]>();
  const tabs: TabMeta[] = [];

  for (const tabState of snapshot.tabStates) {
    const isActiveTab = tabState.id === snapshot.activeTabId;
    const msgs = isActiveTab
      ? currentTabMessages
      : tabState.messages.filter((m) => m.role !== "system" || m.showInChat);
    tabMessages.set(tabState.id, msgs);

    const cores =
      isActiveTab && currentTabCoreMessages ? currentTabCoreMessages : tabState.coreMessages;
    tabCoreMessages.set(tabState.id, cores);

    // Extract checkpoint git tags for session persistence (include redo stack
    // so undo→save→restore→redo works)
    const cpStore = useCheckpointStore.getState();
    const cpState = cpStore.getCheckpoints(tabState.id);
    const redoStack = cpStore.getTab(tabState.id).redoStack;
    const seen = new Set<string>();
    const checkpointTags: Array<{ index: number; anchorMessageId: string; gitTag: string }> = [];
    for (const cp of cpState) {
      if (cp.gitTag && !seen.has(cp.gitTag)) {
        seen.add(cp.gitTag);
        checkpointTags.push({
          index: cp.index,
          anchorMessageId: cp.anchorMessageId,
          gitTag: cp.gitTag,
        });
      }
    }
    for (const entry of redoStack) {
      const cp = entry.checkpoint;
      if (cp.gitTag && !seen.has(cp.gitTag)) {
        seen.add(cp.gitTag);
        checkpointTags.push({
          index: cp.index,
          anchorMessageId: cp.anchorMessageId,
          gitTag: cp.gitTag,
        });
      }
    }

    const uiSnapshot = useUIStore.getState();
    const verboseForTab = uiSnapshot.verboseByTab[tabState.id];

    tabs.push({
      id: tabState.id,
      label: tabState.label,
      activeModel: tabState.activeModel,
      sessionId: tabState.sessionId,
      planMode: tabState.planMode,
      planRequest: tabState.planRequest,
      coAuthorCommits: tabState.coAuthorCommits,
      forgeMode: tabState.forgeMode,
      tokenUsage: tabState.tokenUsage,
      messageRange: { startLine: 0, endLine: msgs.length },
      ...(checkpointTags.length > 0 ? { checkpointTags } : {}),
      ...(verboseForTab !== undefined ? { verbose: verboseForTab } : {}),
    });
  }

  const allMsgs = [...tabMessages.values()].flat();
  const startedAt = allMsgs[0]?.timestamp ?? Date.now();

  const activeTabState = snapshot.tabStates.find((t) => t.id === snapshot.activeTabId);
  const meta: SessionMeta = {
    id: sessionId,
    title,
    ...(customTitle ? { customTitle } : {}),
    cwd,
    startedAt,
    updatedAt: Date.now(),
    activeTabId: snapshot.activeTabId,
    forgeMode: activeTabState?.forgeMode ?? "default",
    tabs,
  };

  return { meta, tabMessages, tabCoreMessages };
}
