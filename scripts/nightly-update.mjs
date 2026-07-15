#!/usr/bin/env node
/**
 * ClearFlow nightly update
 * ------------------------
 * Runs inside GitHub Actions on a schedule. Asks Claude (via the Anthropic
 * Messages API + the built-in web_search server tool) to research new or
 * changed US wastewater treatment projects, then patches the results
 * straight into clearflow-dashboard.html.
 *
 * Requires the ANTHROPIC_API_KEY environment variable (set as a GitHub
 * Actions repo secret — see README.md).
 *
 * This intentionally mirrors the logic of the dashboard's own in-browser
 * add/delete code: PROJECTS is the source of truth, DELETED_IDS is a
 * permanent denylist that this script must never re-add, and only
 * PROJECTS / OWNER_CONTACTS / FIRM_CONTACTS / LAST_CHECKED are touched.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, "..", "clearflow-dashboard.html");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLEARFLOW_MODEL || "claude-sonnet-5";
const DRY_RUN = process.env.CLEARFLOW_DRY_RUN === "true";

if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY environment variable. Add it as a GitHub Actions repo secret.");
  process.exit(1);
}

// ---------- helpers ----------

function extractBlock(source, regex, label) {
  const match = source.match(regex);
  if (!match) throw new Error(`Could not find ${label} in clearflow-dashboard.html`);
  return match[0];
}

function evalLiteral(jsLiteralText) {
  // The arrays/objects in the file are valid JS literals (not necessarily
  // valid JSON — some entries use unquoted keys). Evaluate them as JS.
  // Safe here: this is our own file, not untrusted input.
  return new Function(`"use strict"; return (${jsLiteralText});`)();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fuzzyMatchesDeleted(candidate, deletedIds, deletedProjectsMeta) {
  if (deletedIds.includes(candidate.id)) return true;
  const name = (candidate.name || "").toLowerCase();
  const location = (candidate.location || "").toLowerCase();
  return deletedProjectsMeta.some((d) => {
    const dName = (d.name || "").toLowerCase();
    const dLoc = (d.location || "").toLowerCase();
    if (!dName) return false;
    const nameClose = name && dName && (name.includes(dName) || dName.includes(name));
    const locClose = !dLoc || !location || location.includes(dLoc) || dLoc.includes(location);
    return nameClose && locClose;
  });
}

// ---------- 1. Read + parse the current file ----------

const fileText = await readFile(DASHBOARD_PATH, "utf8");

const lastCheckedBlock = extractBlock(fileText, /const LAST_CHECKED = "[^"]*";/, "LAST_CHECKED");
const projectsBlock = extractBlock(fileText, /const PROJECTS = \[[\s\S]*?\n\];/, "PROJECTS array");
const deletedBlock = extractBlock(fileText, /const DELETED_IDS = \[[\s\S]*?\];/, "DELETED_IDS array");
const ownerContactsBlock = extractBlock(fileText, /const OWNER_CONTACTS = \{[\s\S]*?\n\};/, "OWNER_CONTACTS object");
const firmContactsBlock = extractBlock(fileText, /const FIRM_CONTACTS = \[[\s\S]*?\n\];/, "FIRM_CONTACTS array");

const PROJECTS = evalLiteral(projectsBlock.replace(/^const PROJECTS = /, "").replace(/;$/, ""));
const DELETED_IDS = evalLiteral(deletedBlock.replace(/^const DELETED_IDS = /, "").replace(/;$/, ""));
const OWNER_CONTACTS = evalLiteral(ownerContactsBlock.replace(/^const OWNER_CONTACTS = /, "").replace(/;$/, ""));
const FIRM_CONTACTS = evalLiteral(firmContactsBlock.replace(/^const FIRM_CONTACTS = /, "").replace(/;$/, ""));

console.log(`Loaded ${PROJECTS.length} projects, ${DELETED_IDS.length} deleted ids, ${Object.keys(OWNER_CONTACTS).length} owner contacts, ${FIRM_CONTACTS.length} firm contacts.`);

// Compact context for the prompt — keep this small so we're not paying to
// re-send full project records on every run.
const existingProjectsCompact = PROJECTS.map((p) => ({
  id: p.id,
  name: p.name,
  location: p.location,
  stage: p.stage,
  lastUpdated: p.lastUpdated,
}));
const knownOwners = Object.keys(OWNER_CONTACTS);
const knownFirms = FIRM_CONTACTS.map((f) => f.name).filter(Boolean);

// ---------- 2. Ask Claude to research ----------

const SYSTEM_PROMPT = `You are researching US wastewater treatment project activity for the ClearFlow tracker.

Search across: EPA Clean Water State Revolving Fund (CWSRF) state Intended Use Plans/Priority Lists, EPA WIFIA loan announcements, USDA Rural Development Water & Environmental Programs, EPA ECHO enforcement/consent decrees, NACWA and WEF updates, SAM.gov federal contract opportunities, ENR/Dodge Construction Network, trade publications (Water Finance & Management, WaterWorld), engineering/EPC firm newsrooms (Jacobs, AECOM, Black & Veatch, CDM Smith, Hazen and Sawyer, Stantec, etc.), municipal bond disclosures (EMMA/MSRB), county/municipal capital improvement plans, USACE Civil Works, FEMA Hazard Mitigation/BRIC, ASCE Infrastructure Report Card, state environmental/infrastructure finance agency newsrooms (PENNVEST, EGLE, DANR, KDHE, OWRB, DNREC, Wisconsin DNR, etc.), governor's office press releases, Indian Health Service Sanitation Facilities Construction Program, state/local bid procurement networks, and regional/local news coverage.

Look for: municipal, county, tribal, and regional plant new construction, expansion, upgrade/rehabilitation, nutrient removal (BNR), biosolids handling, collection system/CSO, disinfection upgrade, and consolidation/regionalization projects.

You are given:
- DELETED_IDS: project ids a human has permanently removed from the tracker via its dashboard. NEVER propose any of these again, including under a different id, slightly different name, or rediscovered via a new source. This overrides everything else — being newly found in search is not grounds to re-add something on this list.
- EXISTING_PROJECTS: a compact list of projects already tracked (id, name, location, stage, lastUpdated). Do not propose these as new. Only include one in "updatedProjects" if you have found a genuine, citable material change to its stage, owner, leadFirm, competingFirms, estValue, fundingSource, timeline, or notes.
- KNOWN_OWNERS / KNOWN_FIRMS: names already present in the contact tables. Only propose newOwnerContacts/newFirmContacts for names NOT in these lists, and only when you found a real, citable website/phone for them — never guess.

When you are done researching, respond with ONLY a single fenced \`\`\`json code block as the very last thing in your reply, containing an object with this exact shape:

{
  "newProjects": [
    {
      "id": "st-shortname-topic-2026",
      "name": "...", "location": "City, ST", "type": "...", "stage": "...",
      "owner": "...", "capacity": "...", "leadFirm": "...", "competingFirms": [],
      "estValue": "...", "fundingSource": "...", "timeline": "...",
      "source": "...", "sourceUrl": "https://...",
      "notes": "..."
    }
  ],
  "updatedProjects": [
    { "id": "existing-id", "stage": "...", "notes": "..." }
  ],
  "newOwnerContacts": {
    "Owner Name": { "website": "https://...", "phone": "..." }
  },
  "newFirmContacts": [
    { "name": "...", "website": "https://...", "phone": "..." }
  ]
}

Rules:
- "id" for newProjects must be a unique lowercase-kebab id following the existing pattern (state-place-topic-year), not already in EXISTING_PROJECTS or DELETED_IDS.
- Only include an entry in "updatedProjects" for fields that actually changed — always include "id", never include "dateAdded".
- If you find nothing new or changed, return empty arrays/objects for each key. Do not fabricate projects or contacts.
- Do not include any text after the closing \`\`\` of the JSON block.`;

const userMessage = `DELETED_IDS = ${JSON.stringify(DELETED_IDS)}

EXISTING_PROJECTS = ${JSON.stringify(existingProjectsCompact)}

KNOWN_OWNERS = ${JSON.stringify(knownOwners)}

KNOWN_FIRMS = ${JSON.stringify(knownFirms)}

Today's date is ${todayISO()}. Research current wastewater treatment project activity and report back per the instructions in your system prompt.`;

async function callClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 20 }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  return res.json();
}

let messages = [{ role: "user", content: userMessage }];
let response = await callClaude(messages);
let turns = 1;

while (response.stop_reason === "pause_turn" && turns < 6) {
  console.log(`Search turn ${turns} paused mid-way, continuing...`);
  messages = [...messages, { role: "assistant", content: response.content }];
  response = await callClaude(messages);
  turns += 1;
}

if (response.stop_reason === "max_tokens") {
  console.warn("Warning: response hit max_tokens — final JSON may be truncated.");
}

const finalText = response.content
  .filter((block) => block.type === "text")
  .map((block) => block.text)
  .join("\n");

const jsonMatch = finalText.match(/```json\s*([\s\S]*?)```/);
if (!jsonMatch) {
  console.error("Could not find a ```json block in Claude's response. Full text:\n" + finalText);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(jsonMatch[1]);
} catch (err) {
  console.error("Failed to parse JSON payload:", err.message);
  console.error(jsonMatch[1]);
  process.exit(1);
}

const newProjects = Array.isArray(payload.newProjects) ? payload.newProjects : [];
const updatedProjects = Array.isArray(payload.updatedProjects) ? payload.updatedProjects : [];
const newOwnerContacts = payload.newOwnerContacts && typeof payload.newOwnerContacts === "object" ? payload.newOwnerContacts : {};
const newFirmContacts = Array.isArray(payload.newFirmContacts) ? payload.newFirmContacts : [];

console.log(`Claude proposed ${newProjects.length} new project(s), ${updatedProjects.length} update(s), ${Object.keys(newOwnerContacts).length} new owner contact(s), ${newFirmContacts.length} new firm contact(s).`);

// ---------- 3. Merge, respecting DELETED_IDS and existing data ----------

const today = todayISO();
const existingIds = new Set(PROJECTS.map((p) => p.id));
// Deleted projects only exist as ids in this file, so fuzzy matching here
// falls back to id-only unless the dashboard denylist is later extended
// with name/location metadata.
let addedCount = 0;
for (const candidate of newProjects) {
  if (!candidate || !candidate.id || !candidate.name) continue;
  if (fuzzyMatchesDeleted(candidate, DELETED_IDS, [])) {
    console.log(`Skipping "${candidate.name}" — matches a deleted project id.`);
    continue;
  }
  if (existingIds.has(candidate.id)) {
    console.log(`Skipping "${candidate.name}" — id already exists.`);
    continue;
  }
  PROJECTS.push({
    ...candidate,
    dateAdded: today,
    lastUpdated: today,
  });
  existingIds.add(candidate.id);
  addedCount += 1;
}

let updatedCount = 0;
for (const update of updatedProjects) {
  if (!update || !update.id) continue;
  const idx = PROJECTS.findIndex((p) => p.id === update.id);
  if (idx === -1) continue;
  const { id, dateAdded, lastUpdated, ...changes } = update;
  if (Object.keys(changes).length === 0) continue;
  PROJECTS[idx] = { ...PROJECTS[idx], ...changes, lastUpdated: today };
  updatedCount += 1;
}

for (const [ownerName, contact] of Object.entries(newOwnerContacts)) {
  if (!OWNER_CONTACTS[ownerName]) {
    OWNER_CONTACTS[ownerName] = contact;
  }
}

const existingFirmNames = new Set(FIRM_CONTACTS.map((f) => f.name));
for (const firm of newFirmContacts) {
  if (firm && firm.name && !existingFirmNames.has(firm.name)) {
    FIRM_CONTACTS.push(firm);
    existingFirmNames.add(firm.name);
  }
}

console.log(`Applied ${addedCount} new project(s) and ${updatedCount} update(s).`);

// ---------- 4. Write back ----------

if (DRY_RUN) {
  console.log("CLEARFLOW_DRY_RUN=true — not writing file.");
  process.exit(0);
}

const newProjectsBlock = `const PROJECTS = ${JSON.stringify(PROJECTS, null, 2)};`;
const newOwnerContactsBlock = `const OWNER_CONTACTS = ${JSON.stringify(OWNER_CONTACTS, null, 2)};`;
const newFirmContactsBlock = `const FIRM_CONTACTS = ${JSON.stringify(FIRM_CONTACTS, null, 2)};`;
const newLastCheckedBlock = `const LAST_CHECKED = "${today}";`;

let updatedFile = fileText
  .replace(lastCheckedBlock, newLastCheckedBlock)
  .replace(projectsBlock, newProjectsBlock)
  .replace(ownerContactsBlock, newOwnerContactsBlock)
  .replace(firmContactsBlock, newFirmContactsBlock);
// DELETED_IDS is intentionally never touched here.

await writeFile(DASHBOARD_PATH, updatedFile, "utf8");
console.log(`Wrote updated clearflow-dashboard.html (LAST_CHECKED=${today}).`);
