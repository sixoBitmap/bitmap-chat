// Graph -> system-prompt text. Compact, line-oriented, and BYTE-DETERMINISTIC:
// the same graph must always serialize to the same bytes, or Anthropic prompt
// caching re-writes the cache on every turn instead of reading it (~10x cost).
// Determinism here means: stable sort orders everywhere, and no Date.now() —
// the only timestamp used is graph.crawledAt, fixed at crawl time.

const EST_CHARS_PER_TOKEN = 3.5;
export const estTokens = (s) => Math.ceil(s.length / EST_CHARS_PER_TOKEN);

const short = (id) => String(id).slice(0, 12);
const ownerShort = (a) => (a ? `${a.slice(0, 5)}..${a.slice(-4)}` : "?");
const dateOf = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "?");
const bytesOf = (n) => (n == null ? "?" : n >= 10_000 ? `${Math.round(n / 1000)}KB` : `${n}B`);

// stable node ordering: by inscription number, unknown numbers last, ties by id
const byNumber = (a, b) =>
  (a.number ?? Infinity) - (b.number ?? Infinity) || String(a.id).localeCompare(String(b.id));

function contentLines(node, indent, opts) {
  if (node.text == null) return [];
  let text = node.text;
  if (/^application\/json/i.test(node.content_type || "")) {
    try { text = JSON.stringify(JSON.parse(text)); } catch {}
  }
  if (opts.clipText && text.length > opts.clipText) text = text.slice(0, opts.clipText) + "…";
  const marker = node.textTruncated === "clipped" || (opts.clipText && node.text.length > opts.clipText) ? " [clipped]" : "";
  const lines = text.split("\n");
  const out = lines.slice(0, 40).map((line, i) =>
    i === 0 ? `${indent}CONTENT${marker}: ${line}` : `${indent}  ${line}`);
  if (lines.length > 40) out.push(`${indent}  …[${lines.length - 40} more lines omitted]`);
  return out;
}

// serializeGraph(graph, budgetTokens) -> { text, estTokens, trimNotes }
export function serializeGraph(graph, budgetTokens = 150_000) {
  const attempts = [
    {},                                                          // full
    { dropHtml: true },                                          // 1: drop text/html bodies
    { dropHtml: true, clipText: 400 },                           // 2: clip all text to 400 chars
    { dropHtml: true, clipText: 400, dropDeepContent: 2 },       // 3: no content below depth 2
    { dropHtml: true, clipText: 200, dropDeepContent: 1, collapseSiblings: 100 }, // 4: last resort
  ];
  const notesFor = [
    [],
    ["html inscription bodies omitted for space"],
    ["html bodies omitted; text content clipped to 400 chars"],
    ["html bodies omitted; text clipped to 400 chars; no content below depth 2"],
    ["heavily trimmed: text clipped to 200 chars, content only at depth ≤1, large sibling runs collapsed"],
  ];
  for (let i = 0; i < attempts.length; i++) {
    const text = render(graph, { collapseSiblings: 200, ...attempts[i], trimNotes: notesFor[i] });
    const t = estTokens(text);
    if (t <= budgetTokens || i === attempts.length - 1) {
      return { text, estTokens: t, trimNotes: notesFor[i] };
    }
  }
}

function render(graph, opts) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const root = nodes.get(graph.rootId);
  const s = graph.stats;

  // adjacency (children edges only, child/root kinds — parents/neighbors render separately)
  const childrenOf = new Map();
  const hasTreeParent = new Set();
  for (const e of graph.edges) {
    if (e.type !== "child") continue;
    const from = nodes.get(e.from), to = nodes.get(e.to);
    if (!from || !to) continue;
    if (to.kind !== "child" && to.kind !== "root") continue;
    if (from.kind === "parent" || from.kind === "neighbor-bitmap") continue; // dashed co-parent links listed later
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
    childrenOf.get(e.from).push(to);
    hasTreeParent.add(e.to);
  }
  for (const list of childrenOf.values()) list.sort(byNumber);

  const reinsOf = new Map(); // fromId -> [reinscription nodes]
  for (const e of graph.edges) {
    if (e.type !== "reinscription") continue;
    const to = nodes.get(e.to);
    if (!to) continue;
    if (!reinsOf.has(e.from)) reinsOf.set(e.from, []);
    reinsOf.get(e.from).push(to);
  }
  for (const list of reinsOf.values()) list.sort(byNumber);

  const out = [];
  out.push(`=== BITMAP ${graph.bitmap}.bitmap — ON-CHAIN FAMILY CRAWL (${graph.crawledAt}) ===`);
  out.push(`ROOT ${graph.rootId}  insc#${root?.number ?? "?"}  sat ${root?.sat ?? "?"}  owner ${root?.address ?? "?"}  inscribed ${dateOf(root?.timestamp)}`);
  out.push(`STATS: ${s.nodes} inscriptions total — ${s.children} children (to depth ${s.maxDepth}), ${s.reinscriptions} reinscriptions, ${s.parents} co-parents, ${s.neighbors} neighbor districts; ${s.withText} with text content${graph.includeImages ? `, ${s.withImages} images attached to this chat` : ", images excluded from this crawl (light mode)"}`);
  const truncated = [...new Set(s.truncated)].slice(0, 25);
  out.push(`CAPS HIT: ${truncated.length ? truncated.join(" | ") : "none — the crawl is complete within its caps"}`);
  out.push("");
  out.push("TREE (indent = depth; line: <id-prefix-12> #<insc-number> <content-type> <size> <owner> <date>)");

  const visited = new Set();
  const walk = (node, depth) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const indent = "  ".repeat(depth);
    const label = node.id === graph.rootId
      ? `${short(node.id)} #${node.number ?? "?"} ${node.content_type ?? "?"} ${bytesOf(node.content_length)} ${ownerShort(node.address)} ${dateOf(node.timestamp)}  <- ROOT "${graph.bitmap}.bitmap"`
      : `${short(node.id)} #${node.number ?? "?"} ${node.content_type ?? "?"} ${bytesOf(node.content_length)} ${ownerShort(node.address)} ${dateOf(node.timestamp)}${node.image ? " [image attached to chat]" : ""}`;
    out.push(indent + label);
    const skipContent =
      (opts.dropHtml && /^text\/html/i.test(node.content_type || "")) ||
      (opts.dropDeepContent != null && (node.depth ?? 0) > opts.dropDeepContent);
    if (!skipContent) out.push(...contentLines(node, indent + "  ", opts));
    if (node.childrenTruncated) out.push(`${indent}  (child list truncated — this node has more children than listed)`);
    const kids = childrenOf.get(node.id) || [];
    const cap = opts.collapseSiblings ?? Infinity;
    kids.slice(0, cap).forEach((k) => walk(k, depth + 1));
    if (kids.length > cap) {
      const rest = kids.slice(cap);
      out.push(`${indent}  ... +${rest.length} more children (insc# ${rest[0].number ?? "?"}–${rest[rest.length - 1].number ?? "?"}) omitted from this listing`);
    }
  };
  walk(root, 0);

  // children discovered but detached from the rendered tree (safety net)
  const orphans = graph.nodes.filter((x) => x.kind === "child" && !visited.has(x.id)).sort(byNumber);
  if (orphans.length) {
    out.push("");
    out.push(`UNPLACED CHILDREN (${orphans.length} — discovered but with no crawled tree path):`);
    for (const o of orphans.slice(0, 100)) out.push(`  ${short(o.id)} #${o.number ?? "?"} ${o.content_type ?? "?"}`);
  }

  if (reinsOf.size) {
    out.push("");
    out.push("REINSCRIPTIONS (later inscriptions on the SAME SAT as the node at left; newest last — the newest on the root's sat is the district's profile-image candidate)");
    const froms = [...reinsOf.keys()].map((id) => nodes.get(id)).filter(Boolean).sort(byNumber);
    for (const f of froms) {
      for (const r of reinsOf.get(f.id)) {
        const isLast = r === reinsOf.get(f.id)[reinsOf.get(f.id).length - 1];
        const full = f.id === graph.rootId && isLast; // full id for the profile-image tip
        out.push(`${short(f.id)} <= ${full ? r.id : short(r.id)} #${r.number ?? "?"} ${r.content_type ?? "?"} ${bytesOf(r.content_length)} ${dateOf(r.timestamp)}${f.id === graph.rootId && isLast ? " (latest on root sat)" : ""}${r.image ? " [image attached to chat]" : ""}`);
        // apply the same trim gates as tree nodes — reinscriptions are where HTML bodies concentrate
        const skipR = (opts.dropHtml && /^text\/html/i.test(r.content_type || "")) ||
          (opts.dropDeepContent != null && (r.depth ?? 0) > opts.dropDeepContent);
        if (r.text != null && !skipR) out.push(...contentLines(r, "    ", opts));
      }
    }
  }

  const outside = graph.nodes.filter((x) => x.kind === "parent" || x.kind === "neighbor-bitmap").sort(byNumber);
  if (outside.length) {
    out.push("");
    out.push("CO-PARENTS / NEIGHBOR DISTRICTS (identified, NOT crawled into — their own subtrees are outside this crawl)");
    for (const p of outside) {
      if (p.kind === "neighbor-bitmap") {
        out.push(`neighbor ${p.bitmap}.bitmap  ${p.id}  insc#${p.number ?? "?"}  owner ${p.address ?? "?"}  ~${p.childCount}${p.childrenTruncated ? "+" : ""} children of its own`);
      } else {
        out.push(`co-parent ${short(p.id)} #${p.number ?? "?"} ${p.content_type ?? "?"} owner ${ownerShort(p.address)} (parent of family member(s), not itself a verified bitmap)`);
      }
    }
  }

  out.push("");
  out.push("NOTES FOR THE ASSISTANT:");
  out.push("- ids are shown as 12-char prefixes except the ROOT, neighbor districts, and the latest root-sat reinscription; full ids for every node are visible to the user in the app's graph panel.");
  out.push("- ownership addresses are as-of the crawl timestamp above.");
  for (const note of opts.trimNotes || []) out.push(`- ${note}`);
  for (const t of truncated) out.push(`- cap: ${t}`);
  return out.join("\n");
}
