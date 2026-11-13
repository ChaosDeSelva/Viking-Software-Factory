import { statuses } from "@factory/docs";
import { describe, expect, it } from "vitest";
import { RESEARCH_DECISIONS, REVIEW_POST_STATES, WORK_KINDS } from "./api/work-types.js";
import { isWorkKind } from "./components/WorkKind.js";

/** The values @factory/docs documents for one of Sindri's status groups. */
const documented = (domain: string) =>
  statuses.filter((s) => s.app === "sindri" && s.domain === domain).map((s) => s.value);

describe("work statuses match @factory/docs", () => {
  it.each([
    ["work-kind", WORK_KINDS],
    ["research-decision", RESEARCH_DECISIONS],
    ["review-post", REVIEW_POST_STATES],
  ])("%s values are the ones this UI handles", (domain, handled) => {
    expect(documented(domain).sort()).toEqual([...handled].sort());
  });

  it("every documented work kind has its own badge", () => {
    expect(documented("work-kind").filter((k) => !isWorkKind(k))).toEqual([]);
  });
});
