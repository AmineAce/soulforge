import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { MAX_TERMINALS, type TerminalEntry, useTerminalStore } from "../../stores/terminals.js";
import { listScrollAccel } from "../ui/scroll.js";

function shortenCwd(cwd: string): string {
  const home = process.env.HOME ?? "";
  const display = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = display.split("/");
  if (parts.length <= 3) return display;
  return `${parts[0]}/.../${parts.slice(-2).join("/")}`;
}

function TerminalRow({
  entry,
  index,
  isSelected,
}: {
  entry: TerminalEntry;
  index: number;
  isSelected: boolean;
}) {
  const t = useTheme();
  const statusColor = entry.active ? t.success : t.textDim;
  const statusDot = entry.active ? "●" : "○";

  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={isSelected ? t.bgPopupHighlight : undefined}
    >
      <box height={1}>
        <text truncate>
          <span fg={statusColor}>{statusDot} </span>
          <span fg={isSelected ? t.brand : t.textMuted}>{icon("terminal")} </span>
          <span fg={isSelected ? t.textPrimary : t.textSecondary}>
            {String(index + 1)} {entry.label}
          </span>
          {entry.pid && <span fg={t.textFaint}> [{String(entry.pid)}]</span>}
        </text>
      </box>
      <box height={1} paddingLeft={3}>
        <text truncate>
          <span fg={t.textDim}>{shortenCwd(entry.cwd)}</span>
        </text>
      </box>
    </box>
  );
}

export function TerminalsPanel() {
  const t = useTheme();

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      borderStyle="rounded"
      border={true}
      borderColor={t.textFaint}
    >
      <TerminalList />
    </box>
  );
}

function TerminalList() {
  const t = useTheme();
  const terminals = useTerminalStore((s) => s.terminals);
  const selectedId = useTerminalStore((s) => s.selectedId);

  const activeCount = terminals.filter((e) => e.active).length;
  const deadCount = terminals.length - activeCount;

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
      <box height={1} flexShrink={0} paddingX={1}>
        <text truncate>
          <span fg={t.brandAlt}>{icon("terminal")}</span>
          <span fg={t.textSecondary}> Terminals </span>
          {activeCount > 0 && <span fg={t.success}>{String(activeCount)}</span>}
          {activeCount > 0 && deadCount > 0 && <span fg={t.textFaint}>/</span>}
          {deadCount > 0 && <span fg={t.textDim}>{String(deadCount)}</span>}
          <span fg={t.textFaint}>
            {" "}
            [{String(terminals.length)}/{String(MAX_TERMINALS)}]
          </span>
        </text>
      </box>
      {terminals.length === 0 ? (
        <box paddingX={1}>
          <text>
            <span fg={t.textDim}>No terminals </span>
            <span fg={t.textMuted}>/terminals new</span>
          </text>
        </box>
      ) : (
        <scrollbox flexGrow={1} flexShrink={1} minHeight={0} scrollAcceleration={listScrollAccel}>
          {terminals.map((entry, i) => (
            <TerminalRow
              key={entry.id}
              entry={entry}
              index={i}
              isSelected={entry.id === selectedId}
            />
          ))}
        </scrollbox>
      )}
    </box>
  );
}
