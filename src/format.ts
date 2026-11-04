import type { RunConfig } from "../shared/schema";
import { findModel } from "../shared/models";

/** Short label for the settings a result came from, e.g. "Opus 5.5 · RAG". */
export function configLabel(config?: RunConfig): string {
  if (!config) return "";
  const name = findModel(config.model)?.label.replace(/^Claude /, "") ?? config.model;
  return `${name} · ${config.rag ? "RAG" : "no RAG"}`;
}
