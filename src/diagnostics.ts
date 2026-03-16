import * as vscode from "vscode";
import type { DiagnosticsSummary } from "./types";

export function summarizeDiagnostics(): DiagnosticsSummary {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let hints = 0;

  for (const [, diags] of vscode.languages.getDiagnostics()) {
    for (const d of diags) {
      switch (d.severity) {
        case vscode.DiagnosticSeverity.Error:
          errors++;
          break;
        case vscode.DiagnosticSeverity.Warning:
          warnings++;
          break;
        case vscode.DiagnosticSeverity.Information:
          infos++;
          break;
        case vscode.DiagnosticSeverity.Hint:
          hints++;
          break;
      }
    }
  }

  return { errors, warnings, infos, hints };
}

