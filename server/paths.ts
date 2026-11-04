import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a path relative to a module, e.g. fromModule(import.meta.url, "../kb/").
 * Under Node it's a file: URL. Under a browser-like test environment (jsdom) the module
 * URL is http://.../server/x.ts, so fall back to the same path under the project root.
 */
export function fromModule(moduleUrl: string, relative: string): string {
  const url = new URL(relative, moduleUrl);
  return url.protocol === "file:" ? fileURLToPath(url) : resolve(process.cwd(), decodeURIComponent(url.pathname).replace(/^\//, ""));
}
