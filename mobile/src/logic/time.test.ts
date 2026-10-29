import { dateSeparator, dayKey, formatTime, listTime, toMs } from "./time";

// Built from LOCAL components so the assertions hold in any time zone the suite runs in.
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 10, 30, 1, 30); // Fri Oct 30 2026, 1:30 AM

describe("formatTime", () => {
  it("formats local 12-hour time like a messenger", () => {
    expect(formatTime(at(2026, 10, 29, 19, 1))).toBe("7:01 PM");
    expect(formatTime(at(2026, 10, 29, 0, 5))).toBe("12:05 AM");
    expect(formatTime(at(2026, 10, 29, 12, 0))).toBe("12:00 PM");
    expect(formatTime(new Date(at(2026, 10, 29, 9, 30)).toISOString())).toBe("9:30 AM");
  });
  it("is empty when the time is unknown", () => {
    expect(formatTime(undefined)).toBe("");
    expect(formatTime(null)).toBe("");
    expect(formatTime("not a date")).toBe("");
    expect(toMs("")).toBeNull();
  });
});

describe("dateSeparator", () => {
  it("names today, yesterday, this week's days, then dates", () => {
    expect(dateSeparator(at(2026, 10, 30, 0, 1), NOW)).toBe("Today");
    // 11 PM yesterday is "Yesterday" even though it is under 24 h ago
    expect(dateSeparator(at(2026, 10, 29, 23, 0), NOW)).toBe("Yesterday");
    expect(dateSeparator(at(2026, 10, 27), NOW)).toBe("Tuesday");
    expect(dateSeparator(at(2026, 10, 12), NOW)).toBe("Oct 12");
    expect(dateSeparator(at(2025, 12, 31), NOW)).toBe("Dec 31, 2025");
  });
  it("keys days by the local calendar", () => {
    expect(dayKey(at(2026, 1, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("listTime", () => {
  it("shows a time today and a day word after", () => {
    expect(listTime(at(2026, 10, 30, 0, 45), NOW)).toBe("12:45 AM");
    expect(listTime(at(2026, 10, 29, 18), NOW)).toBe("Yesterday");
    expect(listTime(at(2026, 10, 26), NOW)).toBe("Monday");
    expect(listTime(at(2026, 9, 1), NOW)).toBe("Sep 1");
    expect(listTime(null, NOW)).toBe("");
  });
});
