/**
 * ADMISSION — one bounded record that names exactly what may be promoted, and the ONE
 * function that decides it, run twice: by `prepare` (unprivileged), which writes the
 * record, and again by the privileged `deploy` job over its OWN facts, which must reach
 * the same decision and the same bindings before any credential is requested.
 *
 * An admission is not a set of success flags. It binds:
 *   - the target commit, the mode and whether the run is automatic or manual;
 *   - the certifying run and attempt, and the candidate artifact BY ID AND DIGEST as that
 *     run's own listing states it (never "the first artifact with this name");
 *   - the certification record's digest, the payload tree digest and the payload archive
 *     digest the candidate carries — re-derived from bytes, not read from a claim;
 *   - the fresh assessment's digest, its real collection times and its deadline;
 *   - the TRUSTED verifier revision and the git trees of release/ and dependency-audit/
 *     at that revision, which must still be the trees on main (a policy or verifier that
 *     moved means a new evaluation, never silent acceptance of the old one);
 *   - the evaluation run and attempt that produced it.
 *
 * Nothing in the candidate decides anything here. Its files are data read against facts
 * from outside it: the API's run and artifact listing, the commit and tree as git or the
 * API holds them, the trusted checkout. Pure: every fact is an argument.
 *
 * A PRE-CONTRACT TARGET is classified, not assessed. A commit whose tree does not carry
 * release/policy.json predates this contract: it has no candidate, and none can be
 * manufactured. Deploying one (a rebuild) is refused. ROLLING BACK to one that is already
 * installed is preserved exactly as before this contract — labelled on every record and
 * summary as NOT certified and NOT freshly assessed — pending the owner's decision on
 * retiring it (release/README.md → "Legacy rollback"). It is never described as certified.
 */

import { INPUTS, inspectCandidate } from './certification.mjs';
import { verifyAssessment } from './assessment.mjs';
import { DIGEST_RE, ID_RE, SHA_RE, candidateArtifactName, canonicalJson, isObject, parseJson, reason, same } from './common.mjs';
import { sha256Hex } from './tree.mjs';

export const ADMISSION_SCHEMA = 'dinify.admin.admission/1';
export const ADMISSION_DOC = 'admission.json';
export const CONTRACT_MARKER = 'release/policy.json';

/**
 * The certifying run and its candidate, from the API's own answers.
 *
 * @param {object} input
 * @param {object} input.policy       the trusted release policy
 * @param {string} input.target       the commit being promoted
 * @param {object} input.ciWorkflow   GET /actions/workflows/ci.yml
 * @param {object} input.run          GET /actions/runs/{id}
 * @param {object} input.artifacts    GET /actions/runs/{id}/artifacts?per_page=100
 */
export function selectCertification({ policy, target, ciWorkflow, run, artifacts }) {
  const problems = [];
  const want = (code, ok, detail) => { if (!ok) problems.push(reason(code, detail)); };
  if (!isObject(run) || !isObject(ciWorkflow)) return { problems: [reason('certification_unavailable', 'the certifying run could not be read')], selection: null };
  want('certification_wrong_workflow', run.workflow_id === ciWorkflow.id && run.path === policy.certification.workflowPath,
    `run ${run.id} belongs to workflow ${run.workflow_id} (${run.path}), not ${policy.certification.workflowPath} (${ciWorkflow.id})`);
  want('certification_wrong_event', run.event === policy.certification.event && `refs/heads/${run.head_branch}` === policy.certification.ref,
    `run ${run.id} was a ${run.event} on ${run.head_branch}; only a ${policy.certification.event} to ${policy.certification.ref} certifies`);
  want('certification_wrong_commit', run.head_sha === target, `run ${run.id} is for ${run.head_sha}, the target is ${target}`);
  want('certification_not_successful', run.status === 'completed' && run.conclusion === 'success', `run ${run.id} is ${run.status}/${run.conclusion}`);
  want('certification_unavailable', Number.isInteger(run.run_attempt) && run.run_attempt >= 1, `run ${run.id} states no attempt`);
  if (problems.length) return { problems, selection: null };

  const name = candidateArtifactName(policy, run.id, run.run_attempt);
  const list = isObject(artifacts) && Array.isArray(artifacts.artifacts) ? artifacts.artifacts : null;
  if (!list || !Number.isInteger(artifacts.total_count) || artifacts.total_count !== list.length) {
    return { problems: [reason('certification_listing_incomplete', `the artifact listing of run ${run.id} is unreadable or incomplete — a partial listing cannot prove which candidate exists`)], selection: null };
  }
  const matches = list.filter((a) => a?.name === name);
  if (matches.length === 0) {
    const others = list.filter((a) => String(a?.name).startsWith(`${policy.certification.artifactPrefix}-`)).map((a) => a.name);
    return {
      problems: [reason('certification_no_candidate', `run ${run.id} attempt ${run.run_attempt} retained no ${name}${others.length ? ` (it lists ${others.join(', ')}, which are other attempts' and not eligible)` : ''}`)],
      selection: null,
    };
  }
  if (matches.length > 1) return { problems: [reason('certification_ambiguous', `run ${run.id} lists ${matches.length} artifacts named ${name}`)], selection: null };
  const a = matches[0];
  want('certification_expired', a.expired === false, `${name} (artifact ${a.id}) has expired; an expired candidate cannot be promoted, and its evidence cannot be reconstructed`);
  want('certification_listing_incomplete', ID_RE.test(String(a.id)) && DIGEST_RE.test(String(a.digest)) && Number.isInteger(a.size_in_bytes),
    `${name} carries no usable id, digest or size in the listing`);
  want('certification_wrong_run', a.workflow_run?.id === run.id && a.workflow_run?.head_sha === target, `${name} is not listed as run ${run.id}'s for ${target}`);
  if (problems.length) return { problems, selection: null };
  return {
    problems: [],
    selection: {
      workflowPath: run.path,
      runId: String(run.id),
      runAttempt: String(run.run_attempt),
      artifact: { id: String(a.id), name, digest: a.digest, size: a.size_in_bytes, createdAt: a.created_at ?? null, expiresAt: a.expires_at ?? null },
    },
  };
}

/**
 * The target commit as the API (or git) holds it: its tree, the git blob of each certified
 * input, and whether it carries this contract at all.
 *
 * @param {object} commit  GET /git/commits/{sha}
 * @param {object} tree    GET /git/trees/{tree}?recursive=1
 */
export function commitFacts({ target, commit, tree }) {
  const problems = [];
  if (!isObject(commit) || commit.sha !== target || !SHA_RE.test(String(commit.tree?.sha))) {
    return { problems: [reason('commit_unreadable', `the commit ${target} could not be read`)], facts: null };
  }
  if (!isObject(tree) || tree.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree)) {
    return { problems: [reason('commit_unreadable', `the tree of ${target} could not be read completely`)], facts: null };
  }
  const blobs = new Map(tree.tree.filter((e) => e?.type === 'blob').map((e) => [e.path, e.sha]));
  const inputBlobs = {};
  for (const p of INPUTS) inputBlobs[p] = blobs.get(p) ?? null;
  return { problems, facts: { tree: commit.tree.sha, inputBlobs, hasContract: blobs.has(CONTRACT_MARKER) } };
}

/** The git tree ids of the trusted paths in a top-level tree listing (GET /git/trees/{tree}). */
export function trustedTrees(listing, paths) {
  if (!isObject(listing) || !Array.isArray(listing.tree)) return null;
  const out = {};
  for (const p of paths) {
    const e = listing.tree.find((x) => x?.path === p && x?.type === 'tree');
    if (!e || !/^[0-9a-f]{40}$/.test(String(e.sha))) return null;
    out[p] = e.sha;
  }
  return out;
}

/**
 * THE DECISION. Returns {decision, kind, reasons, record, deadlineMs, inspection}.
 *
 * @param {object} i
 * @param {object} i.policy            the TRUSTED release policy
 * @param {string} i.target
 * @param {'deploy'|'rollback'} i.mode
 * @param {'automatic'|'manual'} i.source
 * @param {object} i.commit            commitFacts() facts (hasContract, tree, inputBlobs)
 * @param {object} [i.certification]   {ciWorkflow, run, artifacts} as the API answered
 * @param {Map}    [i.candidateFiles]  the downloaded candidate
 * @param {Map}    [i.assessmentFiles] the assessment directory
 * @param {object} i.trusted           {revision, trees, mainTrees, releasePolicyBytes, auditPolicy, auditPolicyBytes, scannerManifest, scannerLock}
 * @param {object} i.evaluation        {runId, runAttempt} of THIS evaluation
 * @param {string} i.now
 */
export function decideAdmission(i) {
  const reasons = [];
  const base = {
    schema: ADMISSION_SCHEMA,
    target: i.target,
    mode: i.mode,
    source: i.source,
    evaluation: { workflowPath: i.policy.evaluation.workflowPath, runId: String(i.evaluation.runId), runAttempt: String(i.evaluation.runAttempt) },
    trusted: {
      revision: i.trusted.revision,
      trees: i.trusted.trees,
      releasePolicySha256: sha256Hex(i.trusted.releasePolicyBytes),
      auditPolicySha256: sha256Hex(i.trusted.auditPolicyBytes),
    },
    decidedAt: i.now,
  };
  const refuse = (extra = {}) => ({ decision: 'refused', kind: extra.kind ?? null, reasons, record: { ...base, decision: 'refused', kind: extra.kind ?? null, reasons }, deadlineMs: NaN, inspection: extra.inspection ?? null });

  if (!['deploy', 'rollback'].includes(i.mode)) reasons.push(reason('mode_invalid', i.mode));
  if (!['automatic', 'manual'].includes(i.source)) reasons.push(reason('source_invalid', i.source));
  if (i.source === 'automatic' && i.mode !== 'deploy') reasons.push(reason('mode_invalid', 'an automatic run only deploys'));
  // The verifier and the policies that decide are the trusted revision's, and must still be main's.
  if (!SHA_RE.test(String(i.trusted.revision))) reasons.push(reason('trusted_unreadable', 'no trusted revision'));
  if (!i.trusted.trees || !i.trusted.mainTrees) reasons.push(reason('trusted_unreadable', 'the trusted trees could not be read'));
  else if (!same(i.trusted.trees, i.trusted.mainTrees)) {
    reasons.push(reason('policy_advanced', `release/ or dependency-audit/ on main (${canonicalJson(i.trusted.mainTrees)}) is not the verifier this run is using (${canonicalJson(i.trusted.trees)}); a new evaluation is required`));
  }
  if (!i.trusted.auditPolicy) reasons.push(reason('trusted_unreadable', 'the trusted dependency-audit policy is invalid'));
  if (!i.commit) reasons.push(reason('commit_unreadable', i.target));
  if (reasons.length) return refuse();

  // A target that predates the contract.
  if (!i.commit.hasContract) {
    if (i.mode === 'rollback') {
      const record = { ...base, decision: 'legacy', kind: 'legacy-rollback', certified: false, assessed: false, reasons: [] };
      return { decision: 'legacy', kind: 'legacy-rollback', reasons: [], record, deadlineMs: NaN, inspection: null };
    }
    reasons.push(reason('pre_contract_target', `${i.target} predates release certification (${CONTRACT_MARKER} is absent from its tree); it has no certified candidate and a rebuild is not one — only an already-installed release of it can be rolled back to`));
    return refuse({ kind: 'legacy' });
  }

  // THE CERTIFIED PATH.
  const sel = selectCertification({ policy: i.policy, target: i.target, ...(i.certification ?? {}) });
  reasons.push(...sel.problems);
  if (!sel.selection) return refuse({ kind: 'certified' });
  const inspection = inspectCandidate(i.candidateFiles ?? new Map(), {
    policy: i.policy, commit: i.target, tree: i.commit.tree, inputBlobs: i.commit.inputBlobs,
    runId: sel.selection.runId, runAttempt: sel.selection.runAttempt,
  });
  reasons.push(...inspection.problems);
  if (reasons.length) return refuse({ kind: 'certified', inspection });

  const verified = verifyAssessment(i.assessmentFiles ?? new Map(), {
    inspection, auditPolicy: i.trusted.auditPolicy, auditPolicyBytes: i.trusted.auditPolicyBytes,
    scannerManifest: i.trusted.scannerManifest, scannerLock: i.trusted.scannerLock, releasePolicy: i.policy, now: i.now,
  });
  reasons.push(...verified.problems);
  if (verified.doc) {
    const a = verified.doc;
    if (a.assessor?.revision !== i.trusted.revision) reasons.push(reason('assessment_not_current', `assessed by ${a.assessor?.revision}, the trusted verifier is ${i.trusted.revision}`));
    if (a.assessor?.runId !== String(i.evaluation.runId) || a.assessor?.runAttempt !== String(i.evaluation.runAttempt) || a.assessor?.workflowPath !== i.policy.evaluation.workflowPath) {
      reasons.push(reason('assessment_not_current', `assessed by run ${a.assessor?.runId} attempt ${a.assessor?.runAttempt} of ${a.assessor?.workflowPath}, this evaluation is run ${i.evaluation.runId} attempt ${i.evaluation.runAttempt}`));
    }
    if (a.candidate?.artifactId !== sel.selection.artifact.id || a.candidate?.artifactDigest !== sel.selection.artifact.digest) {
      reasons.push(reason('assessment_wrong_candidate', `assessed artifact ${a.candidate?.artifactId}, the selected candidate is ${sel.selection.artifact.id}`));
    }
  }
  if (reasons.length) return refuse({ kind: 'certified', inspection });

  const a = verified.doc;
  const record = {
    ...base,
    decision: 'admitted',
    kind: 'certified',
    certification: { ...sel.selection, recordDigest: inspection.recordDigest },
    payload: {
      treeDigest: inspection.payload.treeDigest,
      entryCount: inspection.payload.entryCount,
      archiveSha256: inspection.payload.archiveSha256,
      archiveBytes: inspection.payload.archiveBytes,
      indexSha256: inspection.payload.indexSha256,
      entries: inspection.payload.entries,
    },
    assessment: {
      digest: verified.digest,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      decidedAt: a.decidedAt,
      outcome: a.outcome,
      headline: a.headline,
      counts: a.counts,
      recordsApplied: a.recordsApplied,
      deadline: new Date(verified.deadlineMs).toISOString(),
      assessor: a.assessor,
    },
    reasons: [],
  };
  return { decision: 'admitted', kind: 'certified', reasons: [], record, deadlineMs: verified.deadlineMs, inspection };
}

/** The bindings two independent decisions must agree on (everything but when and why). */
const BINDINGS = ['schema', 'decision', 'kind', 'target', 'mode', 'source', 'evaluation', 'trusted', 'certification', 'payload', 'assessment', 'certified', 'assessed'];
export const bindingsOf = (record) => Object.fromEntries(BINDINGS.filter((k) => k in (record ?? {})).map((k) => [k, record[k]]));

/**
 * The privileged job's check: decide AGAIN over its own facts, then require the uploaded
 * admission to say exactly the same thing, and leave enough time before the deadline for
 * the host to act on it. Returns {ok, reasons, verified} where `verified` carries only the
 * bounded values the remote procedure receives.
 */
export function verifyAdmission(admissionBytes, input, { now, marginMinutes }) {
  const reasons = [];
  const parsed = parseJson(admissionBytes);
  if (!parsed.ok || !isObject(parsed.value) || parsed.value.schema !== ADMISSION_SCHEMA) {
    return { ok: false, reasons: [reason('admission_unreadable', parsed.ok ? 'not an admission record' : parsed.detail)], verified: null };
  }
  const uploaded = parsed.value;
  if (!['admitted', 'legacy'].includes(uploaded.decision)) {
    return { ok: false, reasons: [reason('admission_refused', `prepare refused this target: ${(uploaded.reasons ?? []).map((r) => r.code).join(', ') || 'no reason recorded'}`)], verified: null };
  }
  const mine = decideAdmission({ ...input, now });
  reasons.push(...mine.reasons);
  if (mine.decision === 'refused') return { ok: false, reasons, verified: null };
  if (canonicalJson(bindingsOf(mine.record)) !== canonicalJson(bindingsOf(uploaded))) {
    reasons.push(reason('admission_disagrees', 'the privileged decision over its own facts does not bind the same target, candidate, payload, assessment, trusted verifier or evaluation as the uploaded admission'));
    return { ok: false, reasons, verified: null };
  }
  if (mine.kind === 'legacy-rollback') {
    return { ok: true, reasons: [], verified: { kind: 'legacy', target: input.target, mode: 'rollback', payloadTree: '', archiveSha256: '', indexSha256: '', deadlineEpoch: '0' } };
  }
  const remaining = mine.deadlineMs - Date.parse(now);
  if (!(remaining >= marginMinutes * 60_000)) {
    reasons.push(reason('deadline_too_close', `the assessment stops authorising promotion at ${new Date(mine.deadlineMs).toISOString()}, less than ${marginMinutes} minutes away; a new evaluation is required`));
    return { ok: false, reasons, verified: null };
  }
  return {
    ok: true,
    reasons: [],
    verified: {
      kind: 'certified',
      target: input.target,
      mode: input.mode,
      payloadTree: mine.record.payload.treeDigest.replace(/^sha256:/, ''),
      archiveSha256: mine.record.payload.archiveSha256,
      indexSha256: mine.record.payload.indexSha256,
      deadlineEpoch: String(Math.floor(mine.deadlineMs / 1000)),
      entries: mine.record.payload.entries,
    },
  };
}
