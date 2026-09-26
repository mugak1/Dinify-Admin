/**
 * A MODEL of the admin host, for executing the remote procedure EXACTLY as deploy.yml
 * embeds it — the script text is extracted from the workflow file, not restated here.
 *
 * WHAT IS MODELLED, stated so no result below is read as more than it is:
 *   - the three absolute paths the script names (/var/www/dinify-admin,
 *     /var/www/dinify-admin-releases, /usr/local/bin/aws) are relocated under a temporary
 *     root by rewriting exactly those three assignment lines;
 *   - Apache is a `curl` stub that serves files from wherever the live symlink points
 *     (and a canned admin-health answer); the S3 bucket is a directory the `aws` stub
 *     copies from; `df` and `date` may be replaced by stubs to model a full disk or a
 *     clock that passes a deadline mid-run;
 *   - everything else — bash, python3, tar extraction, find, chown, chmod, mv, sha256sum,
 *     mktemp — is the real tool. The script runs as the current user; the matrix runs as
 *     root in CI's container and the ownership checks are real there.
 *
 * Any command the stubs do not recognise exits 99, so a script change that starts calling
 * something new fails loudly here rather than falling through to a real cloud tool.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseYaml } from '../../dependency-audit/tests/yaml-subset.mjs';

export function remoteScriptOf(workflowText) {
  const wf = parseYaml(workflowText);
  const step = wf.jobs.deploy.steps.find((s) => s.name === 'Write remote deploy script');
  const m = step?.run?.match(/cat > deploy\.sh <<'DEPLOY_SCRIPT'\n([\s\S]*?)\nDEPLOY_SCRIPT\n/);
  if (!m) throw new Error('no embedded deploy.sh in the workflow');
  return m[1];
}

/** The Python tree-digest program the remote script embeds, as text. */
export function remoteTreeDigestProgram(script) {
  const m = script.match(/<<'PYTREE'\n([\s\S]*?)\nPYTREE\n/);
  if (!m) throw new Error('no PYTREE program in the remote script');
  return m[1];
}

export function hostModel() {
  const root = mkdtempSync(join(tmpdir(), 'host-'));
  const releases = join(root, 'www', 'dinify-admin-releases');
  const current = join(root, 'www', 'dinify-admin');
  const bucket = join(root, 'bucket');
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  for (const d of [releases, bucket, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(log, '');
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env python3
import os, sys, json
open(${JSON.stringify(log)}, 'a').write('curl ' + sys.argv[-1] + '\\n')
url = sys.argv[-1]
rest = url.split('://', 1)[1]
path = '/' + (rest.split('/', 1)[1] if '/' in rest else '')
path = path.split('?', 1)[0]
live = os.path.realpath(${JSON.stringify(current)})
code, body = 404, b''
if path.startswith('/api/admin/v1/health/'):
    code, body = 200, json.dumps({'status': os.environ.get('MODEL_HEALTH', 'ok')}).encode()
else:
    f = os.path.join(live, path.lstrip('/'))
    if path == '/' or not os.path.isfile(f):
        last = path.rsplit('/', 1)[-1]
        f = os.path.join(live, 'index.html') if (path == '/' or '.' not in last) else None
    if f and os.path.isfile(f):
        code, body = 200, open(f, 'rb').read()
override = os.environ.get('MODEL_OVERRIDE_' + path.strip('/').replace('/', '_').replace('.', '_').upper())
if override is not None:
    body = override.encode()
fmt = sys.argv[sys.argv.index('-w') + 1] if '-w' in sys.argv else ''
tail = fmt.replace('\\\\n', '\\n').replace('%{http_code}', str(code)).encode()
if '-o' in sys.argv:
    open(sys.argv[sys.argv.index('-o') + 1], 'wb').write(body)
    sys.stdout.buffer.write(tail)
else:
    sys.stdout.buffer.write(body + tail)
`);
  writeFileSync(join(bin, 'aws'), `#!/bin/bash
echo "aws $*" >> ${JSON.stringify(log)}
[ "$1" = s3 ] && [ "$2" = cp ] || { echo "model aws: unsupported $*" >&2; exit 99; }
src="\${3#s3://}"; key="\${src#*/}"
cp "${bucket}/$key" "$4"
`);
  for (const f of ['curl', 'aws']) chmodSync(join(bin, f), 0o755);
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${JSON.stringify(log)}\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  return {
    root, releases, current, bucket, bin, log,
    /** A `df` that reports `kb` available — models a nearly full disk. */
    fullDisk: (kb = 0) => stub('df', `printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nmodel 1000 1000 ${kb} 100%% /\\n'`),
    /** A `date +%s` that answers from a list, one per call, then the last forever. */
    clock: (values) => {
      const vals = join(root, 'clock.values');
      const idx = join(root, 'clock.index');
      writeFileSync(vals, `${values.join('\n')}\n`);
      writeFileSync(idx, '0');
      stub('date', [
        'if [ "$*" = "-u +%s" ]; then',
        `  n="$(cat ${JSON.stringify(idx)})"; mapfile -t v < ${JSON.stringify(vals)}`,
        '  i="$n"; [ "$i" -lt "${#v[@]}" ] || i=$(( ${#v[@]} - 1 ))',
        `  echo "\${v[$i]}"; echo $(( n + 1 )) > ${JSON.stringify(idx)}`,
        'else exec /bin/date "$@"; fi',
      ].join('\n'));
    },
    calls: () => readFileSync(log, 'utf8'),
    live: () => realpathSync(current),
    install(name, files) {
      const dir = join(releases, name);
      for (const [p, bytes] of files) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), bytes); }
      return dir;
    },
    point(name) { symlinkSync(join(releases, name), current); },
    listReleases: () => readdirSync(releases).filter((n) => !n.startsWith('.')).sort(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Run the remote procedure with its placeholders filled, under the model. */
export function runRemote(script, host, values, env = {}) {
  let s = script
    .replace(/^CURRENT=\/var\/www\/dinify-admin$/m, `CURRENT=${host.current}`)
    .replace(/^RELEASE_ROOT=\/var\/www\/dinify-admin-releases$/m, `RELEASE_ROOT=${host.releases}`)
    .replace(/^AWS_BIN=\/usr\/local\/bin\/aws$/m, `AWS_BIN=${host.bin}/aws`);
  for (const [k, v] of Object.entries(values)) s = s.split(`__${k}__`).join(v);
  if (/__[A-Z0-9_]+__/.test(s)) throw new Error(`unfilled placeholder: ${s.match(/__[A-Z0-9_]+__/)[0]}`);
  const file = join(host.root, 'deploy.sh');
  writeFileSync(file, s);
  const r = spawnSync('bash', [file], { encoding: 'utf8', env: { PATH: `${host.bin}:/usr/bin:/bin`, ...env }, timeout: 60000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

export { existsSync, lstatSync, readlinkSync };
