const fs = require("node:fs");
const path = require("node:path");

const RESULT_FILES = [
  "docs/data/deals.json",
  "docs/data/status.json",
  "state/repository-state.json",
];

async function githubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "tarifa-radar-scanner",
      "x-github-api-version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload.message || `GitHub respondió ${response.status}.`,
    );
  }
  return payload;
}

async function publishFile(repository, branch, token, filePath, root) {
  const apiUrl = `https://api.github.com/repos/${repository}/contents/${filePath}`;
  const current = await githubRequest(
    `${apiUrl}?ref=${encodeURIComponent(branch)}`,
    token,
  );
  const content = fs.readFileSync(path.resolve(root, filePath)).toString("base64");
  return githubRequest(apiUrl, token, {
    method: "PUT",
    body: JSON.stringify({
      message: `Actualizar ${filePath}`,
      content,
      sha: current.sha,
      branch,
    }),
  });
}

async function publishResults(options = {}) {
  const repository = options.repository || process.env.GITHUB_REPOSITORY;
  const branch = options.branch || process.env.GITHUB_REF_NAME || "main";
  const token = options.token || process.env.GITHUB_TOKEN;
  const root = path.resolve(options.root || process.cwd());
  if (!repository || !token) {
    throw new Error("Faltan GITHUB_REPOSITORY o GITHUB_TOKEN.");
  }

  for (const filePath of RESULT_FILES) {
    await publishFile(repository, branch, token, filePath, root);
  }
  return { published: RESULT_FILES };
}

if (require.main === module) {
  publishResults()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

module.exports = {
  RESULT_FILES,
  githubRequest,
  publishFile,
  publishResults,
};
