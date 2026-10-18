import { describe, expect, it } from "vitest";
import { createLogger } from "./index.js";

describe("createLogger", () => {
  it("creates a pino logger honouring the requested level", () => {
    const logger = createLogger({ level: "silent" });
    expect(logger.level).toBe("silent");
    expect(typeof logger.info).toBe("function");
    expect(createLogger({ level: "debug", name: "x" }).level).toBe("debug");
  });
});
