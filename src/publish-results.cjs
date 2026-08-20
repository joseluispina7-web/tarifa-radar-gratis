const fs = require("node:fs");
const path = require("node:path");

const RESULT_FILES = [
  "config/excluded-hotels.json",
  "docs/data/deals.json",
  "docs/data/status.json",
  "state/repository-state.json",
];

async function githubRequest(url, token, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const { fetchImpl: _fetchImpl, ...requestOptions } = options;
  const response = await fetchImpl(url, {
    ...requestOptions,
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
    const error = new Error(
      payload.message || `GitHub respondió ${response.status}.`,
    );
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function createBlob(repository, token, filePath, root, fetchImpl) {
  const content = fs
    .readFileSync(path.resolve(root, filePath))
    .toString("base64");
  return githubRequest(
    `https://api.github.com/repos/${repository}/git/blobs`,
    token,
    {
      method: "POST",
      fetchImpl,
      body: JSON.stringify({ content, encoding: "base64" }),
    },
  );
}

async function publishFilesAtomic(
  repository,
  branch,
  token,
  root,
  options = {},
) {
  const fetchImpl = options.fetchImpl;
  const api = `https://api.github.com/repos/${repository}`;
  const refPath = `heads/${encodeURIComponent(branch)}`;
  const ref = await githubRequest(`${api}/git/ref/${refPath}`, token, {
    fetchImpl,
  });
  const parentSha = ref.object?.sha;
  if (!parentSha) throw new Error("GitHub no devolvió el commit actual.");
  const parentCommit = await githubRequest(
    `${api}/git/commits/${parentSha}`,
    token,
    { fetchImpl },
  );
  const baseTreeSha = parentCommit.tree?.sha;
  if (!baseTreeSha) throw new Error("GitHub no devolvió el árbol actual.");

  const blobs = await Promise.all(
    RESULT_FILES.map(async (filePath) => ({
      filePath,
      blob: await createBlob(repository, token, filePath, root, fetchImpl),
    })),
  );
  const tree = await githubRequest(`${api}/git/trees`, token, {
    method: "POST",
    fetchImpl,
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: blobs.map(({ filePath, blob }) => ({
        path: filePath,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      })),
    }),
  });
  if (tree.sha === baseTreeSha) {
    return { published: [], skipped: true, commitSha: parentSha };
  }

  const commit = await githubRequest(`${api}/git/commits`, token, {
    method: "POST",
    fetchImpl,
    body: JSON.stringify({
      message: "Actualizar resultados de Tarifa Radar",
      tree: tree.sha,
      parents: [parentSha],
    }),
  });
  try {
    await githubRequest(`${api}/git/refs/${refPath}`, token, {
      method: "PATCH",
      fetchImpl,
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
  } catch (error) {
    if (error.status === 422 && Number(options.attempt || 0) < 1) {
      return publishFilesAtomic(repository, branch, token, root, {
        ...options,
        attempt: Number(options.attempt || 0) + 1,
      });
    }
    throw error;
  }
  return {
    published: RESULT_FILES,
    skipped: false,
    commitSha: commit.sha,
  };
}

async function publishResults(options = {}) {
  const repository = options.repository || process.env.GITHUB_REPOSITORY;
  const branch = options.branch || process.env.GITHUB_REF_NAME || "main";
  const token = options.token || process.env.GITHUB_TOKEN;
  const root = path.resolve(options.root || process.cwd());
  if (!repository || !token) {
    throw new Error("Faltan GITHUB_REPOSITORY o GITHUB_TOKEN.");
  }

  return publishFilesAtomic(repository, branch, token, root, {
    fetchImpl: options.fetchImpl,
  });
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
  createBlob,
  githubRequest,
  publishFilesAtomic,
  publishResults,
};
