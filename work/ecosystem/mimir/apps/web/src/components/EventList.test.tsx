import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { event } from "../test/fixtures.js";
import { EventList } from "./EventList.js";

describe("EventList", () => {
  it("renders payload text as text, never as HTML", () => {
    const { container } = render(
      <EventList
        events={[
          event("session.output", {
            text: "<img src=x onerror=alert(1)>",
            redacted: false,
            lines: 1,
          }),
        ]}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
