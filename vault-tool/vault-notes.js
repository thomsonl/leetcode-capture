// vault-tool/vault-notes.js - shared vault note helpers
//
// Extracted so both the manual CLI (log-session.js) and the companion's
// automatic vault-summary feature (companion/companion.js) build on the same
// per-problem/per-topic note-linking logic instead of two parallel
// implementations. Node CommonJS, no deps, same as the rest of vault-tool.

const fs = require("fs");
const path = require("path");
const os = require("os");

function defaultVaultPath() {
  return path.join(os.homedir(), "Documents", "My Brain");
}

const DEFAULT_ALGORITHMS_SUBFOLDER = path.join("Study", "Algorithms");

// Optional, gitignored config file at the repo root letting a user other
// than Thomson point this tool at their own vault without touching code or
// setting env vars every session. Plain JSON, parsed with JSON.parse, per
// this project's no-external-deps convention (see CLAUDE.md). Both keys are
// optional; a missing file is not an error - it just means "use env vars
// and/or the built-in defaults", which is what Thomson's own setup already
// relies on.
function vaultConfigFilePath() {
  return path.join(__dirname, "..", "vault.config.json");
}

function loadVaultConfigFile() {
  const configPath = vaultConfigFilePath();
  if (!fs.existsSync(configPath)) return {};

  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`Could not read vault config file at ${configPath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Vault config file at ${configPath} is not valid JSON: ${err.message}`);
  }
}

// Single place both log-session.js and companion/vault-summary.js resolve
// the vault path and the algorithm-notes subfolder through, so the two
// consumers can never disagree on precedence. Precedence, highest first:
// explicit env var, then the config file, then the built-in default - so a
// vault.config.json with no VAULT_PATH/VAULT_ALGORITHMS_SUBFOLDER set still
// lets a stray env var win, and no config file at all reproduces Thomson's
// existing behavior exactly.
function resolveVaultConfig() {
  const fileConfig = loadVaultConfigFile();
  const vaultPath = process.env.VAULT_PATH || fileConfig.vaultPath || defaultVaultPath();
  const algorithmsSubfolder =
    process.env.VAULT_ALGORITHMS_SUBFOLDER || fileConfig.algorithmsSubfolder || DEFAULT_ALGORITHMS_SUBFOLDER;
  return { vaultPath, algorithmsSubfolder };
}

// Fails loudly, naming the exact path and how to fix it, rather than letting
// a wrong or unset vault path silently fabricate a brand-new folder tree
// (the old behavior - ensurePerProblemNoteFile used to mkdirSync the whole
// path unconditionally). A missing .obsidian folder only warns, since a
// legitimate vault path passed via config/env could plausibly not carry one
// (e.g. .obsidian excluded from a synced copy) - that's a much lower-risk
// false negative than treating a bare "does this directory exist" check as
// fatal would be.
function validateVaultPath(vaultPath) {
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    throw new Error(
      `Vault path does not exist: ${vaultPath}\n` +
        "Set VAULT_PATH, or \"vaultPath\" in vault.config.json (see README.md), to your Obsidian vault's absolute path."
    );
  }
  if (!fs.existsSync(path.join(vaultPath, ".obsidian"))) {
    console.warn(`Warning: ${vaultPath} exists but has no .obsidian folder - is this really an Obsidian vault?`);
  }
}

// Shared with log-session.js's per-problem note filenames, so the manual CLI
// and the automatic feature always agree on where a given problem's note
// lives.
function safeFileName(title) {
  return title.replace(/[\\/:*?"<>|]/g, "-");
}

// Searches Study/Algorithms/*.md for a note whose content already links to
// this problem (https://leetcode.com/problems/<slug>/...). This is the
// original log-session.js matching strategy: it finds a topic note Thomson
// has already curated to include this specific problem, regardless of the
// note's filename.
function findTopicNoteByProblemLink(vaultPath, slug, algorithmsSubfolder = DEFAULT_ALGORITHMS_SUBFOLDER) {
  const algDir = path.join(vaultPath, algorithmsSubfolder);
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

// Matches a LeetCode topic tag (e.g. "Dynamic Programming") to an existing
// Study/Algorithms/<Tag>.md note by filename, case-insensitively. Used by
// the automatic vault-summary feature: LeetCode's own tags are the source of
// truth for what topic(s) a problem belongs to (see README.md), but only
// tags that already have a curated topic note in the vault get linked -
// this deliberately does not auto-create a new topic note for every raw
// LeetCode tag (e.g. "Array", "Hash Table" have no note of their own yet),
// since those are curated concept notes with real prose, not stubs to
// generate. Returns the absolute path, or null if no matching note exists.
function findTopicNoteByTagName(vaultPath, tagName, algorithmsSubfolder = DEFAULT_ALGORITHMS_SUBFOLDER) {
  const algDir = path.join(vaultPath, algorithmsSubfolder);
  if (!fs.existsSync(algDir)) return null;

  const target = `${tagName}.md`.toLowerCase();
  const files = fs.readdirSync(algDir).filter((f) => f.endsWith(".md"));
  const match = files.find((f) => f.toLowerCase() === target);
  return match ? path.join(algDir, match) : null;
}

// Finds (or creates, with minimal frontmatter + a heading link) the
// per-problem note under Study/Algorithms/Problems/. Mirrors
// log-session.js's createPerProblemNote frontmatter/heading shape exactly,
// so a note this creates and one log-session.js creates are
// indistinguishable, and either tool can safely extend a note the other one
// started.
function ensurePerProblemNoteFile(
  vaultPath,
  { problemSlug, problemTitle },
  algorithmsSubfolder = DEFAULT_ALGORITHMS_SUBFOLDER
) {
  validateVaultPath(vaultPath);
  const problemsDir = path.join(vaultPath, algorithmsSubfolder, "Problems");
  fs.mkdirSync(problemsDir, { recursive: true });

  const filePath = path.join(problemsDir, `${safeFileName(problemTitle)}.md`);
  if (!fs.existsSync(filePath)) {
    const frontmatter = "---\ntags:\n  - study/algorithms\n---\n\n";
    const heading = `[${problemTitle}](https://leetcode.com/problems/${problemSlug}/)\n`;
    fs.writeFileSync(filePath, frontmatter + heading);
  }
  return filePath;
}

// Returns the current body text of a "## <Header>" section (everything up
// to the next "## " heading or EOF), trimmed - or null if the section
// doesn't exist yet. Used to read what's already there before rewriting it,
// so a rewrite can factor in prior content instead of blindly discarding it.
function readSection(content, header) {
  const idx = content.indexOf(header);
  if (idx === -1) return null;
  const rest = content.slice(idx + header.length);
  const nextMatch = rest.match(/\n##[ \t]/);
  const body = nextMatch ? rest.slice(0, nextMatch.index) : rest;
  const trimmed = body.trim();
  return trimmed || null;
}

// Replaces a "## <Header>" section's body in place with bodyText, or
// appends a new "## <Header>" section at the end of the file if it doesn't
// exist yet. Leaves everything else in the file untouched, including
// whatever section follows. Idempotent: calling this twice with the same
// bodyText produces the same content both times.
function upsertSection(content, header, bodyText) {
  const newSection = `${header}\n\n${bodyText.trim()}\n`;
  const idx = content.indexOf(header);

  if (idx === -1) {
    const base = content.replace(/\n*$/, "\n\n");
    return `${base}${newSection}`;
  }

  const rest = content.slice(idx + header.length);
  const nextMatch = rest.match(/\n##[ \t]/);
  const sectionEndInRest = nextMatch ? nextMatch.index + 1 : rest.length; // +1 keeps the \n that starts the next heading
  const before = content.slice(0, idx);
  const after = rest.slice(sectionEndInRest);

  // newSection already ends in \n; only add a separating blank line when
  // there's a following section to separate from. Without this check,
  // upserting the last section in a file grows it by one blank line on
  // every call - breaking the idempotency callers rely on for "repeated
  // submits on the same problem update the same section in place".
  return after ? `${before}${newSection}\n${after}` : `${before}${newSection}`;
}

module.exports = {
  defaultVaultPath,
  DEFAULT_ALGORITHMS_SUBFOLDER,
  vaultConfigFilePath,
  resolveVaultConfig,
  validateVaultPath,
  safeFileName,
  findTopicNoteByProblemLink,
  findTopicNoteByTagName,
  ensurePerProblemNoteFile,
  readSection,
  upsertSection,
};
