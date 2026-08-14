const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  RESULT_FILES,
  publishResults,
} = require("../src/publish-results.cjs");

test("publishes all scanner files in one atomic commit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tarifa-radar-publish-"));
  t.after(() => {
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  for (const filePath of RESULT_FILES) {
    const absolutePath = path.join(root, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify({ filePath }));
  }

  const requests = [];
  let blob = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method, body });
    if (url.includes("/git/ref/heads/")) {
      return Response.json({ object: { sha: "parent-commit" } });
    }
    if (url.endsWith("/git/commits/parent-commit")) {
      return Response.json({ tree: { sha: "base-tree" } });
    }
    if (url.endsWith("/git/blobs")) {
      blob += 1;
      return Response.json({ sha: `blob-${blob}` });
    }
    if (url.endsWith("/git/trees")) {
      return Response.json({ sha: "new-tree" });
    }
    if (url.endsWith("/git/commits")) {
      return Response.json({ sha: "new-commit" });
    }
    if (url.includes("/git/refs/heads/")) {
      return Response.json({ object: { sha: "new-commit" } });
    }
    return Response.json({ message: "unexpected" }, { status: 500 });
  };

  const result = await publishResults({
    repository: "owner/radar",
    branch: "main",
    token: "token",
    root,
    fetchImpl,
  });
  assert.equal(result.commitSha, "new-commit");
  assert.equal(result.published.length, 3);
  assert.equal(
    requests.filter((request) => request.url.endsWith("/git/commits")).length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.method === "PATCH").length,
    1,
  );
  const treeRequest = requests.find((request) =>
    request.url.endsWith("/git/trees"),
  );
  assert.deepEqual(
    treeRequest.body.tree.map((entry) => entry.path),
    RESULT_FILES,
  );
});
