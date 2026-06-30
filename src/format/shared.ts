// Generic field helpers shared by the storefront and web formatters. Pure,
// dependency-free transforms used to keep tool responses token-efficient.

export function names(list: { description?: string; name?: string }[] | undefined): string[] {
  return (list ?? []).map((x) => x.description ?? x.name).filter((n): n is string => Boolean(n));
}

// Steam stores playtime in minutes; expose hours (1dp) which agents reason about.
export function hours(minutes: number | undefined): number | null {
  return typeof minutes === "number" ? Math.round((minutes / 60) * 10) / 10 : null;
}

// Strip HTML tags from store descriptions / requirements blobs.
export function stripHtml(s: string | undefined): string | null {
  if (!s) return null;
  return (
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

// Format raw price cents (+ optional currency) into a compact label.
export function money(cents: number | undefined, currency: string | undefined): string | null {
  if (typeof cents !== "number") return null;
  const v = (cents / 100).toFixed(2);
  return currency ? `${v} ${currency}` : v;
}

// Unix seconds → ISO date (YYYY-MM-DD), or null.
export function isoDay(ts: number | undefined): string | null {
  return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
}
