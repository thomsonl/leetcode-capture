// Regression test for the shared vault note helpers (vault-notes.js). These
// back both the manual CLI (log-session.js) and the companion's automatic
// vault-summary feature, so a bug here silently corrupts real vault notes on
// both paths. Exercises real files under a temp directory, not mocks.
//
// Run with: node --test vault-tool/vault-notes.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  defaultVaultPath,
  vaultConfigFilePath,
  resolveVaultConfig,
  validateVaultPath,
  safeFileName,
  findTopicNoteByProblemLink,
  findTopicNoteByTagName,
  ensurePerProblemNoteFile,
  readSection,
  upsertSection,
} = require("./vault-notes");

function makeTempVault() {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-capture-vault-test-"));
  const algDir = path.join(vaultPath, "Study", "Algorithms");
  fs.mkdirSync(algDir, { recursive: true });
  return vaultPath;
}

// resolveVaultConfig() reads vault.config.json from a fixed path derived
// from __dirname inside vault-notes.js, so these tests swap the real config
// file (if any - there shouldn't be one committed) out of the way for the
// duration of each test rather than parameterizing the function, keeping
// the production code path identical to what callers actually use.
function withVaultConfigFile(contentsOrNull, fn) {
  const configPath = vaultConfigFilePath();
  const backupPath = `${configPath}.test-backup`;
  const hadExisting = fs.existsSync(configPath);
  if (hadExisting) fs.renameSync(configPath, backupPath);

  try {
    if (contentsOrNull !== null) fs.writeFileSync(configPath, contentsOrNull);
    fn();
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    if (hadExisting) fs.renameSync(backupPath, configPath);
  }
}

function withEnv(vars, fn) {
  const prior = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("safeFileName strips filesystem-unsafe characters", () => {
  assert.equal(safeFileName('A/B: C? "D"'), "A-B- C- -D-");
});

test("findTopicNoteByProblemLink matches on existing content link, not filename", () => {
  const vaultPath = makeTempVault();
  const notePath = path.join(vaultPath, "Study", "Algorithms", "Arrays and Hashing.md");
  fs.writeFileSync(
    notePath,
    "## LeetCode Problems\n\n- [x] [1. Two Sum](https://leetcode.com/problems/two-sum/)\n"
  );

  const found = findTopicNoteByProblemLink(vaultPath, "two-sum");
  assert.equal(found, notePath);
  assert.equal(findTopicNoteByProblemLink(vaultPath, "house-robber"), null);
});

test("findTopicNoteByTagName matches an existing topic note by filename, case-insensitively", () => {
  const vaultPath = makeTempVault();
  const notePath = path.join(vaultPath, "Study", "Algorithms", "Dynamic Programming.md");
  fs.writeFileSync(notePath, "---\ntags:\n  - study/algorithms\n---\n\nDP notes.\n");

  assert.equal(findTopicNoteByTagName(vaultPath, "dynamic programming"), notePath);
  assert.equal(findTopicNoteByTagName(vaultPath, "Dynamic Programming"), notePath);
  // A raw LeetCode tag with no curated note yet must not match anything -
  // the automatic feature relies on this to avoid inventing stub topic notes.
  assert.equal(findTopicNoteByTagName(vaultPath, "Array"), null);
});

test("ensurePerProblemNoteFile creates a note once and reuses it on repeat calls", () => {
  const vaultPath = makeTempVault();
  const args = { problemSlug: "house-robber", problemTitle: "198. House Robber" };

  const firstPath = ensurePerProblemNoteFile(vaultPath, args);
  assert.match(fs.readFileSync(firstPath, "utf8"), /198\. House Robber.*leetcode\.com\/problems\/house-robber/s);

  // Simulate the note having since been edited (e.g. an AI Notes section
  // added by a prior submit); a second call must not clobber it.
  fs.appendFileSync(firstPath, "\n## AI Notes\n\nexisting content\n");
  const secondPath = ensurePerProblemNoteFile(vaultPath, args);
  assert.equal(secondPath, firstPath);
  assert.match(fs.readFileSync(secondPath, "utf8"), /existing content/);
});

test("upsertSection inserts, replaces in place, and is idempotent", () => {
  let content = "---\ntags:\n  - study/algorithms\n---\n\n[Title](url)\n";

  content = upsertSection(content, "## AI Notes", "**Rating:** 3/5\n\nfirst pass");
  assert.match(content, /## AI Notes\n\n\*\*Rating:\*\* 3\/5\n\nfirst pass/);

  content += "\n## Other Section\n\nunrelated, must survive\n";

  const rewritten = upsertSection(content, "## AI Notes", "**Rating:** 5/5\n\nsecond pass");
  assert.match(rewritten, /\*\*Rating:\*\* 5\/5\n\nsecond pass/);
  assert.doesNotMatch(rewritten, /first pass/);
  assert.match(rewritten, /## Other Section\n\nunrelated, must survive/);

  const rewrittenAgain = upsertSection(rewritten, "## AI Notes", "**Rating:** 5/5\n\nsecond pass");
  assert.equal(rewrittenAgain, rewritten, "re-applying the same body must be a no-op");
});

test("readSection returns null for a missing section and the trimmed body for an existing one", () => {
  const content = "# Note\n\n## AI Notes\n\nbody text here\n\n## Next\n\nother\n";
  assert.equal(readSection(content, "## AI Notes"), "body text here");
  assert.equal(readSection(content, "## Missing"), null);
});

test("resolveVaultConfig falls back to built-in defaults with no config file and no env vars", () => {
  withEnv({ VAULT_PATH: undefined, VAULT_ALGORITHMS_SUBFOLDER: undefined }, () => {
    withVaultConfigFile(null, () => {
      const config = resolveVaultConfig();
      assert.equal(config.vaultPath, defaultVaultPath());
      assert.equal(config.algorithmsSubfolder, path.join("Study", "Algorithms"));
    });
  });
});

test("resolveVaultConfig reads vaultPath and algorithmsSubfolder from the config file", () => {
  withEnv({ VAULT_PATH: undefined, VAULT_ALGORITHMS_SUBFOLDER: undefined }, () => {
    withVaultConfigFile(
      JSON.stringify({ vaultPath: "/tmp/some-other-vault", algorithmsSubfolder: "Notes/DSA" }),
      () => {
        const config = resolveVaultConfig();
        assert.equal(config.vaultPath, "/tmp/some-other-vault");
        assert.equal(config.algorithmsSubfolder, "Notes/DSA");
      }
    );
  });
});

test("resolveVaultConfig prefers env vars over the config file, which is preferred over defaults", () => {
  withVaultConfigFile(
    JSON.stringify({ vaultPath: "/tmp/config-file-vault", algorithmsSubfolder: "Config/Subfolder" }),
    () => {
      withEnv({ VAULT_PATH: "/tmp/env-vault", VAULT_ALGORITHMS_SUBFOLDER: "Env/Subfolder" }, () => {
        const config = resolveVaultConfig();
        assert.equal(config.vaultPath, "/tmp/env-vault");
        assert.equal(config.algorithmsSubfolder, "Env/Subfolder");
      });
    }
  );
});

test("resolveVaultConfig throws a clear error for a malformed config file", () => {
  withVaultConfigFile("{ not valid json", () => {
    assert.throws(() => resolveVaultConfig(), /not valid JSON/);
  });
});

test("validateVaultPath throws naming the exact missing path instead of creating it", () => {
  const missingPath = path.join(os.tmpdir(), "leetcode-capture-does-not-exist-" + Date.now());
  assert.throws(() => validateVaultPath(missingPath), new RegExp(missingPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fs.existsSync(missingPath), false, "must not have been created as a side effect");
});

test("validateVaultPath succeeds for an existing directory (no .obsidian required)", () => {
  const vaultPath = makeTempVault();
  assert.doesNotThrow(() => validateVaultPath(vaultPath));
});

test("ensurePerProblemNoteFile fails loudly instead of fabricating a vault directory tree", () => {
  const missingVaultPath = path.join(os.tmpdir(), "leetcode-capture-missing-vault-" + Date.now());
  assert.throws(
    () => ensurePerProblemNoteFile(missingVaultPath, { problemSlug: "two-sum", problemTitle: "1. Two Sum" }),
    /Vault path does not exist/
  );
  assert.equal(fs.existsSync(missingVaultPath), false);
});

test("findTopicNoteByProblemLink and findTopicNoteByTagName respect a custom algorithmsSubfolder", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-capture-vault-test-"));
  const customDir = path.join(vaultPath, "Notes", "DSA");
  fs.mkdirSync(customDir, { recursive: true });
  const notePath = path.join(customDir, "Dynamic Programming.md");
  fs.writeFileSync(
    notePath,
    "## LeetCode Problems\n\n- [x] [198. House Robber](https://leetcode.com/problems/house-robber/)\n"
  );

  const subfolder = path.join("Notes", "DSA");
  assert.equal(findTopicNoteByProblemLink(vaultPath, "house-robber", subfolder), notePath);
  assert.equal(findTopicNoteByTagName(vaultPath, "dynamic programming", subfolder), notePath);
  // Default subfolder must not find it, proving the parameter is load-bearing.
  assert.equal(findTopicNoteByProblemLink(vaultPath, "house-robber"), null);
});

test("ensurePerProblemNoteFile writes under a custom algorithmsSubfolder", () => {
  const vaultPath = makeTempVault();
  const subfolder = path.join("Notes", "DSA");
  const filePath = ensurePerProblemNoteFile(
    vaultPath,
    { problemSlug: "house-robber", problemTitle: "198. House Robber" },
    subfolder
  );
  assert.equal(filePath, path.join(vaultPath, "Notes", "DSA", "Problems", "198. House Robber.md"));
  assert.equal(fs.existsSync(filePath), true);
});
