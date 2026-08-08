// The house instructions Claude answers by — how to be grounded, when to draw
// a diagram, what tone to take.
//
// This is the FIRST system block of every chat request. The second block is
// the crawled bitmap data and carries the prompt-cache breakpoint, so this
// text sits inside the cached prefix: editing it invalidates the cache and the
// next question re-writes it once (~1.25x input on that turn), then caching
// resumes as normal.
//
// The admin panel can rewrite it live. The edit is saved to disk and read on
// every request, so it takes effect on the next question with no restart. With
// nothing saved (or after "restore default") DEFAULT_PROMPT below is used.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.PROMPT_FILE || path.join(HERE, "..", ".system-prompt.txt");

export const PROMPT_MIN = 40;      // a prompt shorter than this is a mistake
export const PROMPT_MAX = 40_000;  // ~11k tokens; keeps the window for the crawl

export const DEFAULT_PROMPT = `You are the on-chain guide for one Bitcoin bitmap district and its full inscription family. The BITMAP CRAWL DATA below is a point-in-time snapshot gathered exclusively from the ord recursive API: the bitmap's canonical inscription, its children at all crawled depths, co-parents and neighbor districts, reinscriptions on the family's sats, and the content of small text inscriptions.

Grounding rules:
- Answer ONLY from the crawl data. If something is not in it, or is listed as truncated / not crawled, say exactly that. Never invent inscription ids, numbers, owners, counts, or content.
- Ownership and statistics are as-of the crawl timestamp in the data header; they may have changed since.
- Refer to inscriptions as #<inscription-number> plus the 12-char id prefix shown in the data. Only give a full inscription id or an ordinals.com link when the full id actually appears in the data (root, neighbor districts, latest root-sat reinscription).

Diagrams: serve the user's actual need — the answer must be complete in text on its own, and a diagram is an addition, never a substitute or decoration. Include one ONLY when the user asks for a diagram/tree/visualization, or when a structure/relationship answer is genuinely clearer with one. Emit it as a fenced code block starting with \`\`\`mermaid, use "graph TD" or "flowchart TD", keep it small (at most ~50 nodes — the relevant subtree, not the whole family), give every node a SHORT meaningful label in double quotes (e.g. "114588.bitmap root", "insc 76458571 pathscribe"), and never use a raw # character inside a label — write "insc 123456" instead.

Style: lead with the answer, then supporting detail. Keep responses focused and concise; skip filler and preamble. Use short lists or tables when enumerating inscriptions.

Domain primer: a bitmap district is claimed by inscribing the plain text "<n>.bitmap"; the FIRST such inscription (tracked by the inscribed bitmap index) is canonical. Children of the bitmap inscription are commonly parcels or derivative assets. A child with multiple parents links districts — its co-parents are "neighbor districts". Reinscribing on the SAME SAT as the bitmap is the convention for attaching data to a district; the newest reinscription on the root's sat is commonly treated as its profile image.`;

// --- the live prompt ---------------------------------------------------------
let custom = null;   // null = using DEFAULT_PROMPT
let savedAt = null;

try {
  const raw = fs.readFileSync(FILE, "utf8");
  if (raw.trim().length >= PROMPT_MIN) {
    custom = raw;
    savedAt = fs.statSync(FILE).mtimeMs;
    console.log(`prompt: using the custom system prompt from ${path.basename(FILE)} (${raw.length} chars)`);
  }
} catch { /* none saved — the default it is */ }

// Read on EVERY request, so an admin edit lands on the next question.
export const systemPrompt = () => custom ?? DEFAULT_PROMPT;

export function promptState() {
  const text = systemPrompt();
  return {
    text,
    isDefault: custom === null,
    savedAt,
    chars: text.length,
    estTokens: Math.round(text.length / 3.5), // same rough measure context.js uses
    defaultText: DEFAULT_PROMPT,
    min: PROMPT_MIN,
    max: PROMPT_MAX,
  };
}

// Saving text identical to the default just goes back to the default, so the
// panel never shows "custom" for a prompt that is not actually different.
export function setPrompt(raw) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n").trimEnd();
  if (text.trim().length < PROMPT_MIN) {
    throw Object.assign(new Error(`the prompt needs at least ${PROMPT_MIN} characters`), { code: 400 });
  }
  if (text.length > PROMPT_MAX) {
    throw Object.assign(new Error(`the prompt is too long (${text.length} of ${PROMPT_MAX} characters)`), { code: 400 });
  }
  if (text === DEFAULT_PROMPT.trimEnd()) return resetPrompt();
  fs.writeFileSync(FILE, text, "utf8");   // throws -> the route reports it, memory stays honest
  custom = text;
  savedAt = Date.now();
  return promptState();
}

// --- readers' own instructions ----------------------------------------------
// A reader can wrap the house prompt with two texts of their own: one ABOVE it
// and one BELOW it. Priority is positional and spelled out for the model —
// earlier wins — so above > house > below, exactly the order they are read in.
export const USER_PROMPT_MAX = Number(process.env.USER_PROMPT_MAX) || 4000;
// a dual holder rewrites the whole house prompt, so their slot is roomier
export const USER_MAIN_MAX = Number(process.env.USER_MAIN_MAX) || 12_000;

const trim = (s, max = USER_PROMPT_MAX) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);

// `main` replaces the house prompt for THIS reader only (dual holders) — the
// app-wide prompt is still whatever the admin panel saved.
export function composeSystem({ above = "", below = "", main = "" } = {}) {
  const a = trim(above), b = trim(below), m = trim(main, USER_MAIN_MAX);
  const house = m || systemPrompt();
  // nothing added -> byte-identical to the shared prompt, so the prompt cache
  // stays common to every reader who hasn't customised anything
  if (!a && !b && !m) return systemPrompt();

  const blocks = [];
  if (a) blocks.push(["HIGHEST PRIORITY — instructions from the reader", a]);
  blocks.push([a ? "the app's house instructions" : "HIGHEST PRIORITY — the app's house instructions", house]);
  if (b) blocks.push(["LOWEST PRIORITY — extra notes from the reader", b]);

  const head = `You are given ${blocks.length} sets of instructions, in priority order. Follow all of them. Where two of them genuinely conflict, the one listed EARLIER wins.`;
  const body = blocks.map(([label, text], i) =>
    `--- ${i + 1} of ${blocks.length} · ${label} ---\n${text}`);
  return [head, ...body].join("\n\n");
}

export function resetPrompt() {
  try { fs.unlinkSync(FILE); } catch { /* already gone */ }
  custom = null;
  savedAt = null;
  return promptState();
}
