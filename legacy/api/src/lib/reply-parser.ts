import type { AttendanceResponse } from "@mealplanner/shared";

// Fuzzy-parse an inbound SMS body into a yes/no attendance answer.
// Returns "pending" when the message can't be confidently classified.
const YES = new Set(["y", "yes", "yep", "yeah", "yup", "ya", "sure", "in", "1", "👍", "aye", "def", "definitely"]);
const NO = new Set(["n", "no", "nope", "nah", "out", "0", "👎", "cant", "can't", "skip", "away"]);

export function parseAttendanceReply(body: string): AttendanceResponse {
  const cleaned = body.trim().toLowerCase().replace(/[.!,]/g, "");
  if (!cleaned) return "pending";

  // First check the whole message, then the first token.
  const candidates = [cleaned, cleaned.split(/\s+/)[0] ?? ""];
  for (const c of candidates) {
    if (YES.has(c)) return "yes";
    if (NO.has(c)) return "no";
  }

  // Substring fallback: "yes please", "no thanks", "I'm out tonight".
  if (/\byes\b|\bin\b/.test(cleaned)) return "yes";
  if (/\bno\b|\bout\b|not\b/.test(cleaned)) return "no";

  return "pending";
}
