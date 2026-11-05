/**
 * Fixtures for the shipped-change check (release/lib/shipped.mjs): API-shaped commit and
 * tree documents, the served commit's CI run and artifact listing, and the 4 November 2026
 * REPLAY — real git objects, read from this repository's history.
 */

const hex = (c, n = 40) => c.repeat(n);
const typeOf = (mode) => (mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob');

/**
 * A commit and its recursive tree, as GET /git/commits/{sha} and
 * GET /git/trees/{tree}?recursive=1 state them. `entries` is [[path, mode, sha], …].
 */
export function apiTree(sha, treeSha, entries, { truncated = false } = {}) {
  return {
    commit: { sha, tree: { sha: treeSha } },
    tree: { sha: treeSha, truncated, tree: entries.map(([path, mode, id]) => ({ path, mode, type: typeOf(mode), sha: id })) },
  };
}

/** The served commit's CI facts: the workflow, the run listing, the run and its artifacts. */
export function servedCI(served, { runId = 4242, attempt = 1, daysLeft = 30, expired = false, expiresAt, artifact = true, now = Date.now() } = {}) {
  const at = expiresAt !== undefined ? expiresAt : new Date(now + daysLeft * 86400000).toISOString();
  const artifacts = artifact
    ? [{ id: 77, name: `admin-candidate-${runId}-${attempt}`, digest: `sha256:${hex('a', 64)}`, size_in_bytes: 1024, expired, expires_at: at, workflow_run: { id: runId, head_sha: served } }]
    : [];
  return {
    ciWorkflow: { id: 9 },
    runs: { total_count: 1, workflow_runs: [{ id: runId, head_sha: served, event: 'push', head_branch: 'main', conclusion: 'success' }] },
    run: { id: runId, workflow_id: 9, path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', head_sha: served, status: 'completed', conclusion: 'success', run_attempt: attempt },
    artifacts: { total_count: artifacts.length, artifacts },
  };
}

// ── THE 4 NOVEMBER 2026 REPLAY ──────────────────────────────────────────────────────────
// Every path any of the four merges touched, at each commit (all 100644 blobs). Paths that
// none of them touched are identical at every commit and cannot change a decision.
export const REPLAY_PATHS = Object.freeze([
  '.github/workflows/claude-code-review.yml',
  '.github/workflows/claude.yml',
  'CLAUDE.md',
  'dependency-audit/README.md',
  'dependency-audit/policy.json',
  'dependency-audit/tests/audit.test.mjs',
  'package-lock.json',
  'release/README.md',
  'src/app/core/api/error-message.spec.ts',
  'src/app/core/api/error-message.ts',
  'src/app/dev/mock-restaurant-api.spec.ts',
  'src/app/dev/mock-restaurant-api.ts',
  'src/app/features/restaurant-detail.page.spec.ts',
  'src/app/features/restaurant-tabs.pages.ts'
]);

const REPLAY_OBJECTS = {
  '52643afa6b7979f6e269f25025a339ea95e98f81': { tree: 'aa3fedcacaea9b648127ad1e2f0c155d553899a6', blobs: [
    'e4318485d1211d5c825715defc2d54ea5f18646a',
    '7af2b2592710bfd4d0a0ede59a334f228311ca3a',
    'c24e24aa5d68e0ebc70d532177e9cf096b6ca036',
    'd904380c969f9d3b1562ef8605e355b6a82fd96a',
    '7372087c5b588d8ac3867c41ddcbedc8225e0a01',
    '5161a4b40c96636896bc75c00299552d99b6527a',
    '17692efa5b03bf2555d08741aa4a29d7092f0a9e',
    'eec21c10f893b118d115b0a7e21de5bf6512eb3d',
    '29572c148d80b1b22a5e94e949d66f0fa921573e',
    'e3c41b1c54fd4e1039b0ea7b1a78894d476d4c4f',
    '2384f6705e919fe9fc183218ed770c847154316a',
    '91d676aacbb72d8aacf7529fa40d6981298b840c',
    '2ac19480dcc87e7a32f9853dc7cea6ab4d63b4d8',
    'a24986fc8bc6fc64b457417a927b279dcc7e0e3b',
  ] },
  'd73dd042033fe1e3da1afa3f1036053e212957d2': { tree: '93b1f662e4072848d601b376dcce89b31b166012', blobs: [
    'e4318485d1211d5c825715defc2d54ea5f18646a',
    '7af2b2592710bfd4d0a0ede59a334f228311ca3a',
    '0a6d4678cfa8737428c86f8d24b195450fa2444a',
    '75b59d2434633e7279f70181ca481cc8bce6b8cc',
    '4b92ce76d650651c02b07b291246d77f939a7823',
    '4e5bea51af07059db7863d471ed6cda98d8a2492',
    'a8b58fa3885fa9978704c3ca20a52d9cf9475883',
    'caeba49e7b19096977b8c1a882867b5c0e595ff4',
    '29572c148d80b1b22a5e94e949d66f0fa921573e',
    'e3c41b1c54fd4e1039b0ea7b1a78894d476d4c4f',
    '2384f6705e919fe9fc183218ed770c847154316a',
    '91d676aacbb72d8aacf7529fa40d6981298b840c',
    '2ac19480dcc87e7a32f9853dc7cea6ab4d63b4d8',
    'a24986fc8bc6fc64b457417a927b279dcc7e0e3b',
  ] },
  '547e647a0212e9891fa9510ca19e5ac6c25deeb8': { tree: 'bc436244280562d32b978bdbbc15a0ad4e4a4660', blobs: [
    'e4318485d1211d5c825715defc2d54ea5f18646a',
    '7af2b2592710bfd4d0a0ede59a334f228311ca3a',
    '24e90daea58f8f8e0846575598b1efe6dcc36a0c',
    '75b59d2434633e7279f70181ca481cc8bce6b8cc',
    '4b92ce76d650651c02b07b291246d77f939a7823',
    '4e5bea51af07059db7863d471ed6cda98d8a2492',
    'a8b58fa3885fa9978704c3ca20a52d9cf9475883',
    'caeba49e7b19096977b8c1a882867b5c0e595ff4',
    '4a922f5b23ca9547ce9bd3340350762245c4f6ef',
    '8c9f01daf41539de2c7bca2f643b922377776260',
    'db87b767423f88348de9d9044f9e79a1268dc7d6',
    'a363245d135b13212e48880ea9471041f0f14e0e',
    'd088d67066ea2869a4fdadfe6080fa96b48c667e',
    '6548feb9fdb93c7c724d433dd8d5a732c32eb150',
  ] },
  '4765786c5db4a95393796651a0b6cfc385111d73': { tree: 'db3d39e0aa2f3022da0a8c7779dfdad2d8afd2dd', blobs: [
    'e4318485d1211d5c825715defc2d54ea5f18646a',
    '7af2b2592710bfd4d0a0ede59a334f228311ca3a',
    '5636add4ae03527a24670137f6aa5273484ced82',
    'eee4931fdaf7e25af14fbb8bbcba299fcb11da3b',
    'b587b6caef9112a76ac106ee6e0e8c2bbe0c5d59',
    '7e939dab257fe9d37999a77ab4b983fd74b49e12',
    'a8b58fa3885fa9978704c3ca20a52d9cf9475883',
    '3e36d50c339075b24f1357fc03467513c7557eff',
    '4a922f5b23ca9547ce9bd3340350762245c4f6ef',
    '8c9f01daf41539de2c7bca2f643b922377776260',
    'db87b767423f88348de9d9044f9e79a1268dc7d6',
    'a363245d135b13212e48880ea9471041f0f14e0e',
    'd088d67066ea2869a4fdadfe6080fa96b48c667e',
    '6548feb9fdb93c7c724d433dd8d5a732c32eb150',
  ] },
  'efdeadcbe6be6a7faaaaf8c84a0abf0184783f18': { tree: '02b54c01fd480f0633d5a35b78aff00f309be161', blobs: [
    'ed2e09d2abc9d80632e9881775fd5c72f4ca8c7a',
    '5abedf795df1305ca404101b45c347e458799dc3',
    '5636add4ae03527a24670137f6aa5273484ced82',
    'eee4931fdaf7e25af14fbb8bbcba299fcb11da3b',
    'b587b6caef9112a76ac106ee6e0e8c2bbe0c5d59',
    '7e939dab257fe9d37999a77ab4b983fd74b49e12',
    'a8b58fa3885fa9978704c3ca20a52d9cf9475883',
    '3e36d50c339075b24f1357fc03467513c7557eff',
    '4a922f5b23ca9547ce9bd3340350762245c4f6ef',
    '8c9f01daf41539de2c7bca2f643b922377776260',
    'db87b767423f88348de9d9044f9e79a1268dc7d6',
    'a363245d135b13212e48880ea9471041f0f14e0e',
    'd088d67066ea2869a4fdadfe6080fa96b48c667e',
    '6548feb9fdb93c7c724d433dd8d5a732c32eb150',
  ] },
};

/** The commit Admin served before #57 merged, then the four merges in first-parent order. */
export const REPLAY_BASE = '52643afa6b7979f6e269f25025a339ea95e98f81';
export const REPLAY_MERGES = Object.freeze([
  Object.freeze({ pr: '#57', commit: 'd73dd042033fe1e3da1afa3f1036053e212957d2' }),
  Object.freeze({ pr: '#56', commit: '547e647a0212e9891fa9510ca19e5ac6c25deeb8' }),
  Object.freeze({ pr: '#58', commit: '4765786c5db4a95393796651a0b6cfc385111d73' }),
  Object.freeze({ pr: '#59', commit: 'efdeadcbe6be6a7faaaaf8c84a0abf0184783f18' }),
]);

/** A replay commit as API documents. */
export function replayTree(commit) {
  const o = REPLAY_OBJECTS[commit];
  return apiTree(commit, o.tree, REPLAY_PATHS.map((p, i) => [p, '100644', o.blobs[i]]));
}
