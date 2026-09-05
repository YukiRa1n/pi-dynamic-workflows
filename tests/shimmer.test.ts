import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { shimmerText } from "../src/shimmer.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};

describe("shimmerText", () => {
  it("moves an accent crest through the label without changing its visible text", () => {
    const text = "running_subagent";
    const before = shimmerText(text, theme as never, 0);
    const during = shimmerText(text, theme as never, 500);

    assert.notEqual(before, during, "animation phase should change the styled output");
    assert.match(during, /<accent>/, "the moving crest uses the theme accent");
    assert.equal(during.replace(/<\/?(?:dim|muted|accent|bold)>/g, ""), text, "styling must preserve every label cell");
  });

  it("keeps unicode code points intact", () => {
    const text = "审查🙂agent";
    const rendered = shimmerText(text, theme as never, 500);
    const plain = rendered.replace(/<\/?(?:dim|muted|accent|bold)>/g, "");

    assert.equal(plain, text);
    assert.equal(visibleWidth(plain), visibleWidth(text));
  });
});
