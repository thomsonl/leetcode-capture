#!/usr/bin/env node
// LeetCode Capture - vault-logging tool
//
// Manual, explicit v1: given a captured problem's log entries (from the
// relay server's captures.jsonl), produces a short struggle/proficiency
// note and appends it into Thomson's Obsidian vault.
//
// Usage:
//   node log-session.js --slug <problem-slug> [options]
//
// Options:
//   --log <path>       Path to the captures.jsonl log file
//                       (default: ../relay-server/data/captures.jsonl)
//   --vault <path>     Path to the Obsidian vault root
//                       (default: ~/Documents/My Brain)
//   --note <text>      Freeform note text to include (optional)
//   --accepted         Mark the session as accepted (last Submit passed)
//   --dry-run          Print the note instead of writing it
//
// Matching: searches Study/Algorithms/*.md in the vault for a markdown
// link containing /problems/<slug>/. If found, the note is appended under
// that file's "## LeetCode Problems" section. Otherwise, a new per-problem
// note is created under Study/Algorithms/Problems/<Title>.md following the
// vault's existing note conventions (frontmatter tags, etc).

const fs = require("fs");
const path = require("path");
const os = require("os");

function parseArgs(argv) {
  const args = { dryRun: false, accepted: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--slug") args.slug = argv[++i];
    else if (arg === "--log") args.log = argv[++i];
    else if (arg === "--vault") args.vault = argv[++i];
    else if (arg === "--note") args.note = argv[++i];
    else if (arg === "--accepted") args.accepted = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function loadCaptures(logPath, slug) {
  if (!fs.existsSync(logPath)) {
    throw new Error(`log file not found: ${logPath}`);
  }
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    if (entry.problemSlug === slug) entries.push(entry);
  }
  entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return entries;
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function summarize(entries, accepted) {
  if (entries.length === 0) {
    throw new Error("no captures found for this problem slug");
  }

  const runs = entries.filter((e) => e.trigger === "run");
  const submits = entries.filter((e) => e.trigger === "submit");
  const firstRun = runs[0] || entries[0];
  const lastSubmit = submits[submits.length - 1];

  const elapsedMs = lastSubmit
    ? new Date(lastSubmit.timestamp) - new Date(firstRun.timestamp)
    : null;

  // Not every capture necessarily carries a description (older captures
  // predate this field, or the DOM panel wasn't found at capture time), so
  // take the first one that has it.
  const withDescription = entries.find((e) => e.problemDescription);

  return {
    problemSlug: entries[0].problemSlug,
    problemTitle: entries[0].problemTitle || entries[0].problemSlug,
    problemDescription: withDescription ? withDescription.problemDescription : null,
    language: entries[entries.length - 1].language,
    attemptCount: entries.length,
    runCount: runs.length,
    submitCount: submits.length,
    elapsedMs,
    accepted,
    sessionDate: firstRun.timestamp.slice(0, 10),
  };
}

function buildNoteBlock(summary, freeformNote) {
  const elapsed = summary.elapsedMs !== null
    ? formatDuration(summary.elapsedMs)
    : "n/a (no Submit captured)";
  const status = summary.submitCount === 0
    ? "no submit captured"
    : summary.accepted
      ? "accepted"
      : "not accepted";

  const lines = [
    `### Capture session: ${summary.sessionDate}`,
    `- Problem: ${summary.problemTitle} (${summary.problemSlug})`,
    `- Language: ${summary.language}`,
    `- Attempts: ${summary.attemptCount} (${summary.runCount} run, ${summary.submitCount} submit)`,
    `- Elapsed (first Run -> ${summary.submitCount ? "last Submit" : "n/a"}): ${elapsed}`,
    `- Result: ${status}`,
  ];
  if (freeformNote) {
    lines.push(`- Note: ${freeformNote}`);
  }
  let block = lines.join("\n") + "\n";
  if (summary.problemDescription) {
    block += `\n**Problem statement:**\n\n${summary.problemDescription}\n`;
  }
  return block;
}

function findTopicNote(vaultPath, slug) {
  const algDir = path.join(vaultPath, "Study", "Algorithms");
  if (!fs.existsSync(algDir)) return null;

  const files = fs.readdirSync(algDir).filter((f) => f.endsWith(".md"));
  const needle = `/problems/${slug}/`;
  for (const file of files) {
    const fullPath = path.join(algDir, file);
    const content = fs.readFileSync(fullPath, "utf8");
    if (content.includes(needle)) {
      return fullPath;
    }
  }
  return null;
}

function appendToTopicNote(filePath, noteBlock) {
  let content = fs.readFileSync(filePath, "utf8");
  const sectionHeader = "## LeetCode Problems";
  const sectionIdx = content.indexOf(sectionHeader);

  if (sectionIdx === -1) {
    // No existing problems section; append at end of file.
    content = content.replace(/\n*$/, "\n\n") + noteBlock;
  } else {
    // Insert a "Capture Sessions" subsection right after the
    // "## LeetCode Problems" section, before the next "## " heading (or EOF).
    const afterHeader = sectionIdx + sectionHeader.length;
    const nextSectionMatch = content.slice(afterHeader).match(/\n## /);
    const insertAt = nextSectionMatch
      ? afterHeader + nextSectionMatch.index
      : content.length;

    const before = content.slice(0, insertAt).replace(/\n*$/, "\n");
    const after = content.slice(insertAt);
    content = `${before}\n${noteBlock}${after}`;
  }

  fs.writeFileSync(filePath, content);
}

function createPerProblemNote(vaultPath, summary, noteBlock) {
  const problemsDir = path.join(vaultPath, "Study", "Algorithms", "Problems");
  fs.mkdirSync(problemsDir, { recursive: true });

  const safeName = summary.problemTitle.replace(/[\\/:*?"<>|]/g, "-");
  const filePath = path.join(problemsDir, `${safeName}.md`);

  const frontmatter = "---\ntags:\n  - study/algorithms\n---\n\n";
  const heading = `[${summary.problemTitle}](https://leetcode.com/problems/${summary.problemSlug}/)\n\n`;
  const sectionHeader = "## LeetCode Problems\n\n";

  let content;
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf8");
    content = content.replace(/\n*$/, "\n\n") + noteBlock;
  } else {
    content = frontmatter + heading + sectionHeader + noteBlock;
  }

  fs.writeFileSync(filePath, content);
  return filePath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug) {
    console.error("Usage: node log-session.js --slug <problem-slug> [--log <path>] [--vault <path>] [--note <text>] [--accepted] [--dry-run]");
    process.exit(1);
  }

  const logPath = args.log || path.join(__dirname, "..", "relay-server", "data", "captures.jsonl");
  const vaultPath = args.vault || path.join(os.homedir(), "Documents", "My Brain");

  const entries = loadCaptures(logPath, args.slug);
  const summary = summarize(entries, args.accepted);
  const noteBlock = buildNoteBlock(summary, args.note);

  if (args.dryRun) {
    console.log(noteBlock);
    return;
  }

  const topicNote = findTopicNote(vaultPath, args.slug);
  if (topicNote) {
    appendToTopicNote(topicNote, noteBlock);
    console.log(`Appended capture session to ${topicNote}`);
  } else {
    const created = createPerProblemNote(vaultPath, summary, noteBlock);
    console.log(`No matching topic note found; wrote per-problem note to ${created}`);
  }
}

main();
