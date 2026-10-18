// Unit tests for qa:smoke helpers: ADF ticket text, free ports, and the purge residue scan.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { adfText, freePort, rowsMentioning } from "./smoke-helpers.mjs";

const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("adfText", () => {
  it("flattens Atlassian document format paragraphs and list items into lines", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Users need CSV." }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "dates" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "totals" }] }],
            },
          ],
        },
      ],
    };
    expect(adfText(doc)).toBe("Users need CSV.\n- dates\n- totals");
  });
  it("returns an empty string for a missing description", () => {
    expect(adfText(null)).toBe("");
  });
});

describe("freePort", () => {
  it("returns a loopback port that can be bound", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const srv = createServer();
    await new Promise((res, rej) => srv.once("error", rej).listen(port, "127.0.0.1", res));
    await new Promise((res) => srv.close(res));
  });
});

describe("rowsMentioning", () => {
  it("counts rows per table whose any column contains the id, skipping excluded rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-scan-"));
    dirs.push(dir);
    const file = join(dir, "x.db");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE projects (id TEXT, name TEXT);
      CREATE TABLE notes (id INTEGER, body TEXT, blob_col BLOB);
      CREATE TABLE idem (key TEXT, path TEXT);
      INSERT INTO projects VALUES ('prj_1', 'a'), ('prj_2', 'b');
      INSERT INTO notes VALUES (1, 'see prj_1 here', NULL), (2, 'nothing', NULL);
      INSERT INTO idem VALUES ('k-own', '/v1/projects/prj_1/data'), ('k-old', '/v1/projects/prj_1');`);
    db.close();
    const found = rowsMentioning(file, "prj_1", {
      exclude: { idem: { column: "key", values: ["k-own"] } },
    });
    expect(found).toEqual({ projects: 1, notes: 1, idem: 1 });
    expect(rowsMentioning(file, "prj_9")).toEqual({});
  });
});
