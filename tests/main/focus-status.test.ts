import { describe, expect, it } from "vitest";
import { publicStatusText } from "../../src/main/focus-status.js";

describe("Focus public status presentation", () => {
  it.each([
    [{ status_key: "executing", tool_name: "TOOL.LIST" }, "List Tools in progress..."],
    [{ status_key: "__proto__" }, "Working on it..."],
    [{ status_key: "analyzing" }, "Reviewing your request..."],
    [
      { status_key: "executing", detail_text: "[act] budget finalization status retry" },
      "Working on it...",
    ],
    [{ status_key: "executing", step_index: 2, step_total: 3 }, "Working on step 2 of 3..."],
    [
      { status_key: "executing", detail_code: "plan_checkpoint", step_index: 2, step_total: 3 },
      "Finished step 2 of 3.",
    ],
    [
      { status_key: "executing", detail_code: "plan_checkpoint", step_index: 4, step_total: 3 },
      "Working on it...",
    ],
    [{ status_key: "executing", detail_code: "thinking", tool_name: "web.search" }, "Thinking..."],
    [{ status_key: "executing", tool_name: "functions.WEB.SEARCH" }, "Searching the web..."],
    [{ status_key: "executing", tool_name: "weather" }, "Weather in progress..."],
    [{ status_key: "executing", tool_name: "unknown.private_tool" }, "Using a tool..."],
    [{ status_key: "completed", detail_code: "thinking", tool_name: "web.search" }, "Done."],
    [{ status_key: "future_phase", label: "[act] secret" }, "Working on it..."],
    [{ status_key: "working", visibility: " Private " }, null],
    [{ status_key: "working", visibility: "hidden" }, null],
  ])("presents structured status %j", (status, expected) => {
    expect(publicStatusText(status)).toBe(expected);
  });
});
