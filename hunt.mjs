// sussy-seeds MCP driver — hunts ONI seeds on GitHub Actions.
// Spawns the @onimaxxing/sussy-seeds-mcp server over stdio and speaks JSON-RPC.

import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";

// Server entry: prefer a local install for clean stdio; fall back to npx on CI.
const SERVER_CMD = "node";
const LOCAL_CANDIDATES = [
  new URL("./node_modules/@onimaxxing/sussy-seeds-mcp/dist/index.js", import.meta.url),
  new URL("./package/dist/index.js", import.meta.url)
];
let serverEntry = null;
for (const cand of LOCAL_CANDIDATES) {
  const p = decodeURIComponent(cand.pathname).replace(/^\/([A-Za-z]:)/, "$1");
  if (existsSync(p)) { serverEntry = p; break; }
}
const SERVER_ARGS = serverEntry ? [serverEntry] : ["-y", "@onimaxxing/sussy-seeds-mcp"];const TARGET_HITS = Number(process.env.TARGET_HITS || 5);
const SHARD = Number(process.env.SHARD_INDEX || 0);
const TOTAL_SHARDS = Number(process.env.SHARD_TOTAL || 1);
// 32-bit seed space split across shards
const SEED_MAX = 2 ** 32;
const defaultRangeStart = Math.floor((SEED_MAX / TOTAL_SHARDS) * SHARD);
const defaultRangeEnd = Math.floor((SEED_MAX / TOTAL_SHARDS) * (SHARD + 1));
const rangeStart = Number(process.env.SEED_RANGE_START ?? defaultRangeStart);
const rangeEnd = Number(process.env.SEED_RANGE_END ?? defaultRangeEnd);

// ---- The hunt target -----------------------------------------------------
// Cluster: DLC Terra (V-SNDST-C), all DLC packs enabled, Ceres + Relica
// + Aquatic fragments guaranteed-mixed in. Biome mixings stay disabled.
const FORM_STATE = {
  clusterPrefix: "V-SNDST-C",
  seed: 0,
  otherRaw: "0",
  storyTraits: [],
  mixings: {
    DLC2Mixing: 1,            // Frosty Planet Pack — enable
    CeresAsteroidMixing: 2,   // 谷神星碎片 — guaranteed
    DLC3Mixing: 1,            // Bionic Booster Pack — enable
    DLC4Mixing: 1,            // Prehistoric Planet Pack — enable
    PrehistoricAsteroidMixing: 2, // 古迹星碎片 — guaranteed
    DLC5Mixing: 1,            // Aquatic Planet Pack — enable
    AquaticAsteroidMixing: 2  // 汪洋星碎片 — guaranteed
  }
};

// Home-world requirements (requested v4):
//   金/铁/铜/钴/铝火山: each type's combined output >= 0.3 kg/s
//   储油石 Oil Reservoir >=1
//   污水泉 slush_water >=1 (count-only)
//   Home sussiness >=0.60
// Note: adding world.sussy promotes the scan to full worldgen, so it is
// substantially slower than the v3 partial-worldgen scan.
const METAL_GEYSERS = [
  ["molten_gold", "gold"],
  ["molten_iron", "iron"],
  ["molten_copper", "copper"],
  ["molten_cobalt", "cobalt"],
  ["molten_aluminum", "aluminum"]
];
const SPEC = {
  constraints: [
    ...METAL_GEYSERS.map(([geyser]) => ({
      kind: "world.geyser", mode: "require", world: { kind: "homeWorld" },
      geyser, countOp: ">=", n: 1,
      output: { kind: "sum", op: ">=", kgPerSec: 0.3 }
    })),
    {
      kind: "world.oilWells", mode: "require", world: { kind: "homeWorld" },
      op: ">=", n: 1
    },
    {
      kind: "world.geyser", mode: "require", world: { kind: "homeWorld" },
      geyser: "slush_water", countOp: ">=", n: 1
    },
    {
      kind: "world.sussy", mode: "require", world: { kind: "homeWorld" },
      op: ">=", value: 0.6
    }
  ]
};

// ---- Minimal MCP client ---------------------------------------------------

let msgId = 0;
let proc;
const pending = new Map();
let buffer = Buffer.alloc(0);

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    proc.stdin.write(msg + "\n");
  });
}

function notify(method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  proc.stdin.write(msg + "\n");
}

function handleData(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl === -1) return;
    const line = buffer.slice(0, nl).toString().trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed.id !== undefined && pending.has(parsed.id)) {
      const p = pending.get(parsed.id);
      pending.delete(parsed.id);
      if (parsed.error) p.reject(new Error(JSON.stringify(parsed.error)));
      else p.resolve(parsed.result);
    } else if (parsed.method?.startsWith("notifications/")) {
      if (parsed.method === "notifications/progress") {
        const v = parsed.params?.value ?? {};
        console.log(
          `[progress] ${v.status ?? ""} scanned=${v.scanned ?? "?"} hits=${v.matches ?? v.hits ?? "?"}`
        );
      } else if (parsed.method === "notifications/message") {
        console.log(`[log] ${parsed.params?.data ?? ""}`);
      }
    }
  }
}

async function callTool(name, args) {
  const res = await send("tools/call", { name, arguments: args });
  const text = res.content?.map((c) => c.text).join("\n") ?? "{}";
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  return payload;
}

async function main() {
  console.log(`Shard ${SHARD}/${TOTAL_SHARDS}: scanning seeds [${rangeStart}, ${rangeEnd})`);
  console.log("Spawning MCP server…");
  proc = spawn(SERVER_CMD, SERVER_ARGS, {
    stdio: ["pipe", "pipe", "pipe"]
  });
  proc.stdout.on("data", handleData);
  proc.stderr.on("data", (d) => console.error(`[server] ${d.toString().trim()}`));
  const exited = new Promise((_, rej) =>
    proc.on("exit", (code) => rej(new Error(`MCP server exited early (${code})`)))
  );

  await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "actions-hunt", version: "1.0.0" }
  });
  notify("notifications/initialized", {});
  console.log("MCP initialized.");

  // 1. Build the coord from the form state (validates mixing settings too).
  const built = await callTool("buildCoord", { formState: FORM_STATE });
  if (!built.coord) throw new Error(`buildCoord failed: ${JSON.stringify(built)}`);
  const coord = built.coord;
  console.log(`Coord: ${coord}`);
  console.log(`Describe: ${built.describe}`);

  // 2. Sanity-check that no constraint is structurally impossible.
  const verdicts = await callTool("verdictOfSpec", { coord, spec: SPEC });
  console.log("Verdict:", JSON.stringify(verdicts).slice(0, 800));
  if (verdicts.impossibleRequires?.length > 0) {
    throw new Error("Spec has structurally-impossible constraints — fix before scanning.");
  }

  // 3. Smoke test: one seed summary to confirm end-to-end worldgen works.
  const probe = await callTool("probeSummarize", { coord, seed: 1 });
  if (probe.ok === false) throw new Error(`probeSummarize failed: ${JSON.stringify(probe)}`);
  console.log(`Probe ok (${probe.worldCount ?? "?"} worlds). Starting scan…`);

  // 4. Hunt.
  const scanStart = Date.now();
  const result = await callTool("scanUntil", {
    coord,
    spec: SPEC,
    targetHits: TARGET_HITS,
    opts: { seedRangeStart: rangeStart, seedRangeEnd: rangeEnd }
  });

  const meta = result.meta ?? {};
  const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
  console.log(`\nScan done in ${elapsed}s`);
  console.log(`stopReason=${result.stopReason} scanned=${meta.totalScanned} passed=${meta.seedsPassed}`);
  if (meta.seedsFailedWorldgen > 0)
    console.log(`seedsFailedWorldgen=${meta.seedsFailedWorldgen} firstFailure=${meta.firstWorldgenFailure}`);
  if (meta.evalError) console.log(`evalError=${meta.evalError}`);

  const hits = (result.results ?? []).filter((r) => r.pass);
  console.log(`\n=== ${hits.length} HIT(S) ===`);
  for (const h of hits) console.log(`seed ${h.seed}  score ${h.score}  coord ${h.coord}`);

  // 5. Share link (works even with 0 hits? no — requires ≥1 seed).
  let shareUrl = null;
  if (hits.length > 0) {
    try {
      const shared = await callTool("shareResults", {
        coord,
        spec: SPEC,
        seeds: hits.map((h) => h.seed),
        scanLimit: rangeEnd,
        tab: "builder"
      });
      shareUrl = shared.shareUrl ?? null;
      console.log(`Share URL: ${shareUrl}`);
    } catch (e) {
      console.error(`shareResults failed: ${e.message}`);
    }
  }

  // 6. Persist results as artifacts + job summary.
  const out = {
    shard: SHARD, totalShards: TOTAL_SHARDS,
    coord, describe: built.describe,
    stopReason: result.stopReason ?? "unknown",
    totalScanned: meta.totalScanned ?? null,
    seedsPassed: meta.seedsPassed ?? null,
    seedsFailedWorldgen: meta.seedsFailedWorldgen ?? 0,
    elapsedSec: Number(elapsed),
    shareUrl,
    hits: hits.map((h) => ({ seed: h.seed, score: h.score, coord: h.coord }))
  };
  writeFileSync("hits.json", JSON.stringify(out, null, 2));

  const md = [
    "## 🌱 Sussy seed hunt — results",
    "",
    `- **Cluster**: ${built.describe}`,
    `- **Coord**: \`${coord}\``,
    `- **Stop reason**: ${out.stopReason} — scanned ${out.totalScanned ?? "?"} seeds, ${hits.length} hit(s), ${elapsed}s`,
    shareUrl ? `- **Share**: ${shareUrl}` : "",
    "",
    ...(hits.length
      ? ["| seed | score |", "|---|---|", ...hits.map((h) => `| ${h.seed} | ${h.score} |`)]
      : ["No hits in this range yet."])
  ].filter(Boolean).join("\n");
  writeFileSync("summary.md", md);

  if (proc) proc.kill();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(`FATAL: ${e.message}`);
  if (proc) proc.kill();
  process.exit(1);
});
