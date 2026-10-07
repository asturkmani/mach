import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv";

describe("parseCsv", () => {
  it("reads quoted cells, escaped quotes and blank lines", () => {
    expect(parseCsv('Line item,FQ1 2027E\r\n"Revenue ($M)","12,000"\n\n"Note ""est.""",x')).toEqual([
      ["Line item", "FQ1 2027E"],
      ["Revenue ($M)", "12,000"],
      ['Note "est."', "x"],
    ]);
  });
});
