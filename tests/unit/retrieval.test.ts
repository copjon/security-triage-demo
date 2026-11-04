import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndex, getKbIndex, retrieveForTicket, search, tokenize } from "../../server/retrieval.ts";

const DOCS = [
  {
    file: "vendors.md",
    raw: "# Vendor register\n\n## TextFlare (SMS)\nNo BAA. PHI must not be sent.\n\n## Twilio (SMS)\nApproved with a BAA.\n",
  },
  { file: "images.md", raw: "# AppSec standards\n\n## Container base images\nnode:22-bookworm-slim is approved.\n" },
];

describe("tokenize", () => {
  it("lowercases, drops stopwords and short tokens, and strips plural s", () => {
    expect(tokenize("The Vendors are approved for SMS")).toEqual(["vendor", "approved", "sms"]);
  });

  it("keeps words ending in ss", () => {
    expect(tokenize("access")).toEqual(["access"]);
  });
});

describe("buildIndex", () => {
  it("makes one chunk per ## section with a stable id", () => {
    const ids = buildIndex(DOCS).chunks.map((c) => c.id);
    expect(ids).toEqual(["vendors#textflare-sms", "vendors#twilio-sms", "images#container-base-images"]);
  });

  it("uses the # title as the document name", () => {
    expect(buildIndex(DOCS).chunks[0].doc).toBe("Vendor register");
  });
});

describe("search", () => {
  const index = buildIndex(DOCS);

  it("ranks the section that matches rare terms first", () => {
    expect(search(index, "switching reminders to TextFlare")[0].id).toBe("vendors#textflare-sms");
  });

  it("returns nothing when no words match", () => {
    expect(search(index, "quarterly revenue forecast")).toEqual([]);
  });

  it("drops weak matches far below the best one", () => {
    const ids = search(index, "TextFlare TextFlare BAA container").map((r) => r.id);
    expect(ids[0]).toBe("vendors#textflare-sms");
    expect(ids).not.toContain("vendors#twilio-sms");
  });

  it("reports which words matched", () => {
    expect(search(index, "TextFlare BAA")[0].matchedTerms).toEqual(expect.arrayContaining(["textflare", "baa"]));
  });

  it("respects the k limit", () => {
    expect(search(index, "SMS BAA approved node", 1)).toHaveLength(1);
  });
});

describe("getKbIndex", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("rebuilds the index when a knowledge base file changes", () => {
    dir = mkdtempSync(join(tmpdir(), "kb-"));
    const file = join(dir, "a.md");
    writeFileSync(file, "# Doc\n\n## First\nalpha\n");
    expect(getKbIndex(dir).chunks.map((c) => c.section)).toEqual(["First"]);

    writeFileSync(file, "# Doc\n\n## Second\nbeta\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(getKbIndex(dir).chunks.map((c) => c.section)).toEqual(["Second"]);
  });
});

describe("retrieveForTicket (real kb/)", () => {
  it("finds the vendor entry and messaging policy for the SMS vendor ticket", () => {
    const ids = retrieveForTicket({
      id: "SEC-118",
      title: "New SMS vendor for appointment reminders",
      requester: "kevin",
      submitted: "2026-11-03T12:30:00Z",
      body: "We're switching appointment reminders to TextFlare. Legal is still working on their paperwork.",
    }).map((c) => c.id);
    expect(ids).toContain("vendor-register#textflare-sms-messaging");
    expect(ids).toContain("hipaa-policy#messaging-patients");
  });

  it("ranks the leaked-credentials runbook first for a leaked key", () => {
    const [top] = retrieveForTicket({
      id: "SEC-108",
      title: "Rotate leaked AWS key",
      requester: "alex",
      submitted: "2026-11-02T15:10:00Z",
      body: "I accidentally committed an AWS access key to a public GitHub repo. What do I do next?",
    });
    expect(top.id).toBe("incident-runbooks#exposed-or-leaked-cloud-credentials");
  });
});
