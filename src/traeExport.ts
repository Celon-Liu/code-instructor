import * as vscode from "vscode";

export type TraeExportConnectResult =
  | { ok: true; exportPath: string; note: string }
  | { ok: false; note: string };

/**
 * Best-effort: triggers Trae's "export current session" command (if present),
 * then asks user to pick the exported file (or directory).
 */
export async function connectTraeExportFlow(): Promise<TraeExportConnectResult> {
  // Try to trigger export. This may open a save dialog controlled by Trae.
  // If the command doesn't exist, we still allow manual picking.
  try {
    await vscode.commands.executeCommand("workbench.action.icube.aiChatSidebar.exportCurrentSession");
  } catch {
    // ignore
  }

  const picked = await vscode.window.showOpenDialog({
    title: "Select exported Trae session file (recommended: .md / .json) or export folder",
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false
  });
  const uri = picked?.[0];
  if (!uri) return { ok: false, note: "No file/folder selected." };

  return {
    ok: true,
    exportPath: uri.fsPath,
    note: uri.fsPath
  };
}

