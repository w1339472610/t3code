import { describe, expect, it } from "vite-plus/test";

import { monthGrid, startOfWeek, stepAnchor, weekDays } from "./noteDates";

describe("note dates", () => {
  it("starts weeks on Monday, including from a Sunday", () => {
    expect(startOfWeek("2026-11-24")).toBe("2026-11-23");
    expect(startOfWeek("2026-11-29")).toBe("2026-11-23");
    expect(weekDays("2026-12-31")).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
  });

  it("covers the month in whole weeks", () => {
    const grid = monthGrid("2026-11-24");
    expect(grid[0]).toBe("2026-10-26");
    expect(grid.at(-1)).toBe("2026-12-06");
    expect(grid.length).toBe(42);
    expect(monthGrid("2027-02-10")).toHaveLength(28);
  });

  it("clamps to the last day when stepping months", () => {
    expect(stepAnchor("2027-01-31", "month", 1)).toBe("2027-02-28");
    expect(stepAnchor("2026-03-31", "month", -1)).toBe("2026-02-28");
    expect(stepAnchor("2026-11-24", "week", -1)).toBe("2026-11-17");
  });
});
