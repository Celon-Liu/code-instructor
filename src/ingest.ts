export type ExtractedPlanItem = {
  text: string;
  done: boolean;
};

export function extractPlanItems(raw: string): ExtractedPlanItem[] {
  const s = (raw || "").replace(/\r\n/g, "\n");
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: ExtractedPlanItem[] = [];

  for (const line of lines) {
    // Match task checkboxes:
    // - [ ] foo
    // - [x] foo
    const c = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (c && c[2]) {
      out.push({ text: c[2].trim(), done: (c[1] || "").toLowerCase() === "x" });
      continue;
    }

    // Match bullets like:
    // - foo
    // * foo
    // 1. foo
    // 1) foo
    const m = line.match(/^([-*]|(\d+)[.)])\s+(.*)$/);
    if (m && m[3]) {
      out.push({ text: m[3].trim(), done: false });
      continue;
    }

    // Fallback: treat as a step if it's not too short
    if (line.length >= 6) out.push({ text: line, done: false });
  }

  // De-dup while preserving order
  const map = new Map<string, ExtractedPlanItem>();
  for (const item of out) {
    const k = item.text.toLowerCase();
    if (!map.has(k)) {
      map.set(k, item);
      continue;
    }
    // If duplicate appears, keep done=true if any occurrence is done.
    const prev = map.get(k);
    if (prev && !prev.done && item.done) map.set(k, { ...prev, done: true });
  }
  return Array.from(map.values());
}

export function extractPlanSteps(raw: string): string[] {
  return extractPlanItems(raw).map((x) => x.text);
}

export function extractGoalSummary(raw: string): { title: string; summary: string; objectives: string[] } | undefined {
  const s = (raw || "").replace(/\r\n/g, "\n");
  if (!s.trim()) return undefined;
  const lines = s.split("\n");

  const title =
    lines.find((l) => l.trim().startsWith("# "))?.replace(/^#\s+/, "").trim() ||
    lines.find((l) => l.trim().toLowerCase().startsWith("title:"))?.split(":").slice(1).join(":").trim() ||
    "Imported Goal";

  let userBlock = "";
  const userIdx = lines.findIndex((l) => /^##\s*user/i.test(l.trim()));
  if (userIdx >= 0) {
    for (let i = userIdx + 1; i < lines.length; i++) {
      const cur = (lines[i] ?? "").trim();
      if (/^##\s+/.test(cur)) break;
      if (cur) userBlock += (userBlock ? "\n" : "") + cur;
    }
  }

  const summary = (userBlock || lines.slice(0, 20).join(" ")).trim().slice(0, 600);
  if (!summary) return undefined;

  const objectivesFromHeadings = lines
    .filter((l) => /^###\s+/.test(l.trim()))
    .map((l) => l.replace(/^###\s+/, "").trim())
    .filter((l) => l.length > 2)
    .slice(0, 6);

  const objectivesFromPlan = extractPlanSteps(raw).slice(0, 8);
  const noisePattern =
    /(self-check|no executable plan baseline|create or import .*plan|development signals look healthy|continue with next planned step|diagnostics|validity|loop risk|\[pass\]|\[warn\]|\[fail\])/i;
  const objectives = [...new Set([...objectivesFromHeadings, ...objectivesFromPlan])]
    .filter((x) => !noisePattern.test(x))
    .slice(0, 8);
  return { title, summary, objectives };
}

