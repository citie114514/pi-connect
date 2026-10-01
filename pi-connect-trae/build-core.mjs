// Builds pi-extensions/dsh-connect-trae/lib/trae-core.js from the DSH trae bundle.
// 1. Replace imports
// 2. Drop the DSH adapter region (createTraeAdapter uses PiAiAdapter)
// 3. Patch auth paths to a Pi-owned dir
// 4. Patch refreshNow's atomic write to plain fs
// 5. Keep only protocol core (1-3111); strip usage/web-status/DSH entry
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "..", "profiles", "desktop", "node_modules", "dsh-connect-trae", "lib", "index.js");
const DST = join(__dirname, "lib", "trae-core.js");

const lines = readFileSync(SRC, "utf8").split("\n");
console.log(`source lines: ${lines.length}`);

// --- 1. Replace the import block (lines 1-16, 1-based) ---
const NEW_IMPORTS = `/**
 * Trae protocol core for the Pi port of dsh-connect-trae.
 *
 * This module is a surgically extracted copy of the DSH plugin bundle:
 *  - the DSH adapter region (PiAiAdapter / resolveRetryPolicy) is removed;
 *  - the DSH-only usage / web-status / index entry regions are removed;
 *  - the plugin-owned auth-file paths are moved under ~/.pi/agent;
 *  - the atomic-write helpers are replaced with plain fs writes.
 *
 * Everything else (credential store, refresh, identity, shim, protocol,
 * solo upstream, remote catalog, bridge, SSE codec) is unchanged.
 */
import { readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir, cpus, hostname, release } from "node:os";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
`;

// Find the line where "#region src/catalog.ts" starts (currently line 17)
const catalogRegionIdx = lines.findIndex((l) => l.trim() === "//#region src/catalog.ts");
if (catalogRegionIdx < 0) throw new Error("catalog region not found");
const newLines = [...NEW_IMPORTS.split("\n"), ...lines.slice(catalogRegionIdx)];
console.log(`after import replacement: ${newLines.length} lines`);

// --- 2. Remove the adapter region (between src/catalog.ts end and src/decrypt.ts) ---
const decryptIdx = newLines.findIndex((l) => l.trim() === "//#region src/decrypt.ts");
if (decryptIdx < 0) throw new Error("decrypt region not found");
// catalog region spans from catalogRegionIdx to the line before decryptIdx;
// the adapter region sits between them. Find its start.
const adapterStart = newLines.findIndex((l, i) => i > catalogRegionIdx && l.includes("src/adapter.ts"));
if (adapterStart < 0) throw new Error("adapter region marker not found");
const adapterBody = newLines.slice(adapterStart, decryptIdx);
// Verify the adapter body contains the DSH-only pieces
if (!adapterBody.some((l) => l.includes("PiAiAdapter"))) throw new Error("adapter region missing PiAiAdapter");
newLines.splice(adapterStart, decryptIdx - adapterStart);
console.log(`after adapter removal: ${newLines.length} lines`);

// --- 3. Patch traeOwnAuthPath / legacyTraeOwnAuthPath ---
// Replace the function bodies to use a Pi-owned dir under ~/.pi/agent.
const PI_AUTH_DIR = `join(homedir(), ".pi", "agent", "cache", "dsh-connect-trae")`;
let text = newLines.join("\n");
text = text.replace(
  /function traeOwnAuthPath\(region\) \{\n\treturn join\(resolveDshHome\(\), `\$\{TRAE_OWN_PREFIX\}\.\$\{region\}\.json`\);\n\}/,
  `function traeOwnAuthPath(region) {
\treturn join(${PI_AUTH_DIR}, \`\${TRAE_OWN_PREFIX}.\${region}.json\`);
}`,
);
text = text.replace(
  /function legacyTraeOwnAuthPath\(\) \{\n\treturn join\(resolveDshHome\(\), TRAE_AUTH_FILENAME\);\n\}/,
  `function legacyTraeOwnAuthPath() {
\treturn join(${PI_AUTH_DIR}, TRAE_AUTH_FILENAME);
}`,
);
if (text.includes("resolveDshHome")) throw new Error("resolveDshHome still referenced");

// --- 4. Patch refreshNow's atomic write ---
// The template literal contains a literal `\n` escape and ${...} markers, so a
// verbatim match is fragile. Match line-by-line on stable tokens instead.
const ATOMIC_ANCHOR = "const ownPath = this.ownAuthPath();";
const linesArr = text.split("\n");
const anchorIdx = linesArr.findIndex((l) => l.includes(ATOMIC_ANCHOR));
if (anchorIdx < 0) throw new Error("refreshNow ownPath anchor not found");
// The block runs from the anchor to the first following "});" that closes withFileLock
// (a tab-indented "});" line). Replace [anchor, thatClose] with the plain-fs write.
let closeIdx = -1;
for (let i = anchorIdx + 1; i < linesArr.length; i++) {
  if (/^\t\t\t\}\);$/.test(linesArr[i])) {
    closeIdx = i;
    break;
  }
}
if (closeIdx < 0) throw new Error("withFileLock close not found");
const replaced = [
  `\t\t\tconst ownPath = this.ownAuthPath();`,
  `\t\t\tawait mkdir(dirname(ownPath), { recursive: true });`,
  `\t\t\tawait writeFile(ownPath, \`\${JSON.stringify({`,
  `\t\t\t\tversion: OWN_VERSION,`,
  `\t\t\t\tcredential: refreshed`,
  `\t\t\t}, null, 2)}\\n\`, { mode: 384 });`,
];
linesArr.splice(anchorIdx, closeIdx - anchorIdx + 1, ...replaced);
text = linesArr.join("\n");
if (text.includes("withFileLock") || text.includes("writeFileAtomic")) throw new Error("atomic write still referenced");

// --- 4b. Unref the shim's listener ---
// Pi's extension docs forbid starting sockets in the factory; the shim is
// started lazily / from `session_start` instead. `unref()` is the second half
// of that contract: it guarantees the in-process shim can never be what keeps
// a session-less invocation alive.
const LISTEN_RE = /(\n\tserver\.listen\(0, "127\.0\.0\.1"\);)/;
if (!LISTEN_RE.test(text)) throw new Error("trae shim listen call not found");
text = text.replace(
  LISTEN_RE,
  `$1\n\t// Pi port: never let the shim's listener hold the process open.\n\tserver.unref();`,
);

// --- 4c. Complete the reasoning-effort vocabulary ---
// Trae's own `reasoning_effort_options` may name `minimal` / `medium` (this
// file's TRAE_REASONING_EFFORTS lists both). The DSH parser only knew
// light/high/extra_high, and the inverse mapping collapsed every other name
// onto "high" — so a level Trae offered could be advertised to the user as a
// different level. Patch both tables.
const EFFORT_MAP_SRC = 'const EFFORT_MAP = {\n\tlight: "low",\n\thigh: "high",\n\textra_high: "xhigh"\n};';
const EFFORT_MAP_DST = `const EFFORT_MAP = {
	minimal: "minimal",
	light: "low",
	medium: "medium",
	high: "high",
	extra_high: "xhigh"
};
/**
* The inverse of EFFORT_MAP: pi level -> Trae wire spelling.
*
* Kept as an explicit table instead of re-deriving it, because the inline
* ternary this replaces collapsed every name it did not know onto "high":
* "minimal" and "medium" - both of which Trae's own reasoning_effort_options
* may advertise (see TRAE_REASONING_EFFORTS) - were shown to the user as high
* and then sent to Trae as high. Dropping an offered level is bad; relabelling
* it as a different level is worse.
*/
const TRAE_REASONING_WIRE = {
	minimal: "minimal",
	low: "light",
	medium: "medium",
	high: "high",
	xhigh: "extra_high"
};`;
if (!text.includes(EFFORT_MAP_SRC)) throw new Error("EFFORT_MAP block not found");
text = text.replace(EFFORT_MAP_SRC, EFFORT_MAP_DST);
const EFFORT_REVERSE_SRC = 'Object.fromEntries(model.reasoning.supported.map((effort) => [effort, effort === "low" ? "light" : effort === "xhigh" ? "extra_high" : "high"]))';
const EFFORT_REVERSE_DST = 'Object.fromEntries(model.reasoning.supported.map((effort) => [effort, TRAE_REASONING_WIRE[effort] ?? effort]))';
if (!text.includes(EFFORT_REVERSE_SRC)) throw new Error("reasoning-effort inverse mapping not found");
text = text.split(EFFORT_REVERSE_SRC).join(EFFORT_REVERSE_DST);

// --- 4d. Restore the published CN fallback windows and efforts ---
// The bootstrap roster is what Pi serves before the first live directory
// refresh lands (session-less calls, failed refresh, signed out). The DSH
// bundle carried only `contextWindow: 2e5`, so every fallback row advertised the
// dev window and — because it carried no `reasoningEfforts` at all — was
// reported as a non-reasoning model, i.e. thinking permanently off. Both facts
// are reproduced from Trae's own published metadata (see docs/CATALOG_EVIDENCE
// in the DSH bundle): no value here is invented, and `kimi-k2.6` keeps no
// efforts because Trae publishes none for it.
const FB_START = "const FALLBACK_TRAE_MODELS = [";
const fbStart = text.indexOf(FB_START);
if (fbStart < 0) throw new Error("FALLBACK_TRAE_MODELS not found");
const fbEnd = text.indexOf("\n];", fbStart);
if (fbEnd < 0) throw new Error("FALLBACK_TRAE_MODELS end not found");
const FB_DST = `const FALLBACK_TRAE_MODELS = [
	{
		id: "DeepSeek-V4-Flash-Official",
		name: "DeepSeek-V4-Flash",
		contextWindow: 2e5,
		maxContextWindow: 1e6,
		reasoningSupported: true,
		reasoning: { supported: ["low", "high", "xhigh"], defaultEffort: "high" },
		reasoningEfforts: { low: "light", high: "high", xhigh: "extra_high" }
	},
	{
		id: "DeepSeek-V4-Pro-Official",
		name: "DeepSeek-V4-Pro",
		contextWindow: 2e5,
		maxContextWindow: 1e6,
		reasoningSupported: true,
		reasoning: { supported: ["low", "high", "xhigh"], defaultEffort: "high" },
		reasoningEfforts: { low: "light", high: "high", xhigh: "extra_high" }
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 2e5,
		maxContextWindow: 1e6,
		reasoningSupported: true,
		reasoning: { supported: ["high", "xhigh"], defaultEffort: "high" },
		reasoningEfforts: { high: "high", xhigh: "extra_high" }
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 2e5
	}
];`;
text = text.slice(0, fbStart) + FB_DST + text.slice(fbEnd + 3);

// --- 5. Strip the DSH-only regions, keep the protocol core + usage/check-in logic ---
// Kept: everything through `src/web-status.ts` (usage client, check-in status,
// credit/check-in projection helpers used by the Pi commands).
// Stripped from here: model-config / model-detail / redact / raw-envelope /
// upstream / index (DSH card + entry plumbing).
const cutIdx = text.split("\n").findIndex((l) => l.includes("src/model-config.ts"));
if (cutIdx < 0) throw new Error("model-config region marker not found");
const coreLines = text.split("\n").slice(0, cutIdx);
// Trim any trailing blank lines from the core
while (coreLines.length > 0 && coreLines[coreLines.length - 1].trim() === "") coreLines.pop();

const out = [
  ...coreLines,
  "",
  "//#region pi-entry",
  "/** Pi port entry point: re-export the protocol core used by the extension. */",
  "/** Provider route this bundle owns for the domestic (CN) gateway. */",
  "const TRAE_PROVIDER = \"trae\";",
  "/**",
  " * Provider route this bundle owns for the international (trae.ai) gateway.",
  " * Named `-global` to match the plugin family's convention (`workbuddy-global`);",
  " * the internal region bucket stays `ai`, which is the gateway/protocol name.",
  " */",
  "const TRAE_AI_PROVIDER = \"trae-global\";",
  "/** The provider id each region registers as. */",
  "const TRAE_PROVIDERS = {",
  "\tcn: TRAE_PROVIDER,",
  "\tai: TRAE_AI_PROVIDER",
  "};",
  "/** Human-readable provider names, shown in the Pi model picker. */",
  "const TRAE_PROVIDER_DISPLAY_NAMES = {",
  "\tcn: \"Trae\",",
  "\tai: \"Trae Global\"",
  "};",
  "/** Region a provider route id belongs to. */",
  "function regionOfTraeProvider(provider) {",
  "\tfor (const [region, id] of Object.entries(TRAE_PROVIDERS)) if (id === provider) return region;",
  "}",
  "/**",
  " * Conservative context capacity used only when a served model row carries no",
  " * window of its own. Every fallback row and every live Trae row is expected to",
  " * state its real window; this is the backstop that keeps one unsized row from",
  " * failing the entire provider route (INVALID_MODEL_CONTEXT in DSH terms).",
  " */",
  "const FALLBACK_CONTEXT_WINDOW = 2e5;",
  "/** Idle ceiling while one stream read is outstanding. */",
  "const TRAE_STREAM_IDLE_TIMEOUT_MS = 3e5;",
  "export {",
  "  TraeCatalog,",
  "  TraeCredentialStore,",
  "  TraeDelegatingUpstreamClient,",
  "  TraeSoloBridge,",
  "  TraeSoloRemoteCatalogClient,",
  "  TraeSoloUpstreamClient,",
  "  REGION_GATEWAYS,",
  "  SseDecoder,",
  "  TRAE_AI_PROVIDER,",
  "  TRAE_CN_AGENT_TASK_PATH,",
  "  TRAE_CN_TITLE_PATH,",
  "  TRAE_PROVIDER,",
  "  TRAE_PROVIDERS,",
  "  TRAE_PROVIDER_DISPLAY_NAMES,",
  "  TRAE_SOLO_CHAT_PATH,",
  "  TRAE_SOLO_FUNCTION,",
  "  TRAE_SOLO_MODELS_PATH,",
  "  TRAE_SOLO_REMOTE_BASE,",
  "  TRAE_STATE_DB_FILENAME,",
  "  TRAE_STREAM_IDLE_TIMEOUT_MS,",
  "  TRAE_USAGE_PATH,",
  "  TRAE_CHECKIN_PATH,",
  "  TRAE_VERSION_CODE_FALLBACK,",
  "  traeWebUsage,",
  "  applyContextBudgets,",
  "  applyImageSelection,",
  "  applyReasoningEffort,",
  "  bridgeTraeSoloStream,",
  "  buildTraeAgentTaskBody,",
  "  buildTraeCnHeaders,",
  "  buildTraeRawChatDraft,",
  "  buildTraeRawChatRuntimeConfig,",
  "  CHECKIN_DEVICE_ALREADY_CLAIMED,",
  "  classifyTraeRawChatFailure,",
  "  createTraeShim,",
  "  decodeRawChatChunk,",
  "  decodeTraeEvent,",
  "  decryptTraeStorageValue,",
  "  deriveCatalog,",
  "  discoveredCatalog,",
  "  FALLBACK_TRAE_MODELS,",
  "  FALLBACK_TRAE_MODELS_AI,",
  "  fallbackModelsFor,",
  "  identityHeaders,",
  "  legacyTraeOwnAuthPath,",
  "  mergeTraeModelSources,",
  "  normalizeTraeCredential,",
  "  normalizeTraeVersionCode,",
  "  parseReasoningCapability,",
  "  parseTraeAuthValue,",
  "  parseTraeCachedModel,",
  "  parseTraeRemoteModel,",
  "  parseTraeStorageDocument,",
  "  parseUsageSnapshot,",
  "  pickTraeStorageIdentity,",
  "  prepareSoloBody,",
  "  readTraeCachedModel,",
  "  readTraeCliIdentity,",
  "  readTraeIdentity,",
  "  refreshTraeCredential,",
  "  regionOfCredential,",
  "  safeMessage,",
  "  toCheckin,",
  "  toCredits,",
  "  TraeUsageClient,",
  "  regionOfEdition,",
  "  regionOfHost,",
  "  regionOfTraeProvider,",
  "  regionOfUserRegion,",
  "  resolveTraeIdentity,",
  "  resolveTraeRawRuntime,",
  "  sanitizeCatalog,",
  "  traeEndpoint,",
  "  traeInputModalities,",
  "  traeModelDisplayName,",
  "  traeOwnAuthPath,",
  "  traeRawChatExtraInfo,",
  "  traeStateDatabaseCandidates,",
  "  traeStorageCandidates,",
  "  traeWindowsAppNames,",
  "  unwrapVolatile,",
  "  unwrapVolatileDeep,",
  "};",
  "//#endregion",
  "",
].join("\n");

mkdirSync(dirname(DST), { recursive: true });
writeFileSync(DST, out);
console.log(`wrote ${DST} (${out.split("\n").length} lines)`);
