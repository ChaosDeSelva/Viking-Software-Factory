import * as intakePkg from "@sindri/intake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHarness, type Harness } from "./helpers.js";

vi.mock("@sindri/intake", async (importOriginal) => {
  const real = await importOriginal<typeof import("@sindri/intake")>();
  return { ...real, sanitizeForDisplay: vi.fn(real.sanitizeForDisplay) };
});
const spy = vi.mocked(intakePkg.sanitizeForDisplay);

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const RLO = "‮";
const TITLE = `Quoll${RLO} title <b>x</b>`;
const BODY = `quollbody <script>alert(1)</script> ${"word ".repeat(2000)}`;
const COMMENT = `quollcomment <img src=x onerror=alert(1)>`;

describe("intake responses reuse the display text stored at write time (audit M5)", () => {
  it("GET /v1/intakes/:id and the list never re-sanitize ticket or comment text", async () => {
    const hh = (h = await makeHarness());
    const projectId = (
      await hh.call({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "Q", repoPath: hh.repoDir },
      })
    ).json().project.id as string;
    const intakeId = (
      await hh.call({
        method: "POST",
        url: "/v1/intakes",
        payload: { projectId, title: TITLE, body: BODY },
      })
    ).json().intake.id as string;
    intakePkg.openIntake(hh.db).annotate(intakeId, { author: `Q${RLO}`, body: COMMENT });

    spy.mockClear();
    const one = await hh.call({ url: `/v1/intakes/${intakeId}` });
    const list = await hh.call({ url: `/v1/intakes?projectId=${projectId}` });
    expect(one.statusCode).toBe(200);
    const texted = spy.mock.calls.filter(([arg]) => /quoll/.test(arg));
    expect(texted, "ticket text was sanitized again per response").toEqual([]);

    // Still clean on the wire.
    for (const res of [one, list]) {
      const raw = res.body;
      expect(raw).not.toMatch(/<script|<img|<b>/i);
      expect(raw).not.toContain(RLO);
      expect(raw).not.toContain("\\u202e");
    }
    const intake = one.json().intake;
    expect(intake.display.title).toBe("Quoll title x");
    expect(intake.title).toBe(intake.display.title);
    expect(one.json().comments[0].display.body).toBe("quollcomment ");
  });
});
