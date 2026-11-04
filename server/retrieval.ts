/**
 * Retrieval for the RAG step: keyword search (BM25) over the Markdown files in kb/.
 *
 * Each "## " section of a document becomes one chunk. For a ticket, we score every
 * chunk against the ticket's title and body and return the best few. No external
 * service or API key is needed. In production you would usually swap search() for a
 * vector search (embeddings), and keep the rest of the pipeline the same.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fromModule } from "./paths.ts";
import type { RetrievedChunk, Ticket } from "../shared/schema.ts";

interface Chunk {
  id: string; // e.g. "vendor-register#textflare-sms-messaging"
  doc: string; // document title
  section: string; // section heading
  text: string;
  terms: string[];
  tf: Map<string, number>;
}

export interface Index {
  chunks: Chunk[];
  avgLen: number;
  docFreq: Map<string, number>;
}

export interface SourceDoc {
  file: string; // e.g. "vendor-register.md"
  raw: string;
}

// How many chunks to put in the prompt, and how weak a match may be relative to the best one.
export const TOP_K = 4;
export const MIN_RELATIVE_SCORE = 0.4;

// BM25 tuning: k1 limits how much repeating a word helps; b controls length normalization.
const K1 = 1.2;
const B = 0.75;

const STOPWORDS = new Set(
  ("a an and are as at be but by can do does for from has have how i if in into is it its " +
    "just may more must need no not of on or our so that the their them then there these they " +
    "this to up was we were what when which who will with would you your all any also only per " +
    "should than us via want like get got use used using new").split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function buildIndex(docs: SourceDoc[]): Index {
  const chunks: Chunk[] = [];
  for (const { file, raw } of docs) {
    const doc = raw.match(/^# (.+)$/m)?.[1].trim() ?? file;
    const docId = file.replace(/\.md$/, "");
    for (const part of raw.split(/^## /m).slice(1)) {
      const [heading, ...body] = part.split("\n");
      const section = heading.trim();
      const text = body.join("\n").trim();
      // Count the heading twice so a match on the section title weighs more.
      const terms = tokenize(`${section} ${section} ${doc} ${text}`);
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      chunks.push({ id: `${docId}#${slug(section)}`, doc, section, text, terms, tf });
    }
  }
  const docFreq = new Map<string, number>();
  for (const c of chunks) for (const t of c.tf.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const avgLen = chunks.length ? chunks.reduce((n, c) => n + c.terms.length, 0) / chunks.length : 0;
  return { chunks, avgLen, docFreq };
}

export function search(index: Index, query: string, k = TOP_K): RetrievedChunk[] {
  const n = index.chunks.length;
  // Inverse document frequency: rare words (like "TextFlare") count more than common ones.
  const idf = (t: string) => {
    const df = index.docFreq.get(t) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  };
  const queryTerms = [...new Set(tokenize(query))];
  const scored = index.chunks
    .map((c) => {
      let score = 0;
      const matched: string[] = [];
      for (const q of queryTerms) {
        const f = c.tf.get(q);
        if (!f) continue;
        matched.push(q);
        score += (idf(q) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * c.terms.length) / index.avgLen));
      }
      return { c, score, matched };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0]?.score ?? 0;
  return scored
    .filter((s) => s.score >= best * MIN_RELATIVE_SCORE)
    .slice(0, k)
    .map(({ c, score, matched }) => ({
      id: c.id,
      doc: c.doc,
      section: c.section,
      text: c.text,
      score: Math.round(score * 100) / 100,
      matchedTerms: matched.sort((a, b) => idf(b) - idf(a)).slice(0, 8),
    }));
}

// The kb/ folder is re-read whenever a file in it changes, so policy edits take
// effect on the next request without restarting the server.
const KB_DIR = fromModule(import.meta.url, "../kb/");
let cached: { signature: string; index: Index } | undefined;

export function getKbIndex(dir = KB_DIR): Index {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const signature = files.map((f) => `${f}:${statSync(`${dir}/${f}`).mtimeMs}`).join("|") + `@${dir}`;
  if (cached?.signature !== signature) {
    const docs = files.map((file) => ({ file, raw: readFileSync(`${dir}/${file}`, "utf8") }));
    cached = { signature, index: buildIndex(docs) };
  }
  return cached.index;
}

export function retrieveForTicket(ticket: Ticket): RetrievedChunk[] {
  return search(getKbIndex(), `${ticket.title}\n${ticket.body}`);
}
