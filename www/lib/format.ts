// Dates in frontmatter are day-granular; format in UTC so the rendered text is
// stable regardless of the machine running the build.
const longDate = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
});
const fullDate = new Intl.DateTimeFormat("en-US", {
  dateStyle: "full",
  timeZone: "UTC",
});

export function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** `long` renders "June 1, 2024"; `full` adds the weekday, "Sunday, June 1, 2024". */
export function formatDate(
  value: string | Date,
  dateStyle: "long" | "full" = "long",
): string {
  const date = toDate(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return dateStyle === "full"
    ? fullDate.format(date)
    : longDate.format(date);
}
