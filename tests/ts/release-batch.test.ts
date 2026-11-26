import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/bump-version.sh', import.meta.url));
const workflow = readFileSync(new URL('../../.github/workflows/version-bump.yml', import.meta.url), 'utf8');

function repo(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'kn-release-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgSign', 'false');
  mkdirSync(join(cwd, 'web/static'), { recursive: true });
  writeFileSync(join(cwd, 'web/static/version.json'), '{"version":"0.73.14"}\n');
  writeFileSync(join(cwd, 'web/static/changelog.json'), '[{"version":"0.73.14","changes":[]}]\n');
  git('add', 'web');
  git('commit', '-qm', 'chore(version): v0.73.14');
  const add = (subject: string) => git('commit', '--allow-empty', '-qm', subject);
  const run = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  const bump = (notes: string) => run('bash', [script], { PLAYER_NOTES: notes });
  const changelog = () => JSON.parse(readFileSync(join(cwd, 'web/static/changelog.json'), 'utf8'));
  return { cwd, git, add, run, bump, changelog };
}

function workflowStep(name: string) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, name);
  const run = lines.indexOf('        run: |', start);
  assert.ok(run > start, name);
  const next = lines.findIndex((line, index) => index > run && line.startsWith('      - '));
  return lines
    .slice(run + 1, next === -1 ? lines.length : next)
    .join('\n')
    .replace(/^ {10}/gm, '');
}

test('a batch creates one version and uses the supplied notes in player-facing order', (t) => {
  const { add, bump, changelog, git } = repo(t);
  add('fix: internal retry counter');
  add('feat(netplay): add a join option');
  add('fix: close cleanup race');
  const source = git('rev-parse', 'HEAD');
  const result = bump('- Friends can join in the middle of a match.\n- Reconnecting is more reliable.');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git('rev-parse', 'HEAD^'), source);
  assert.equal(git('tag', '--list'), 'v0.74.0');
  const notes = changelog();
  assert.deepEqual(
    notes.map((entry: { version: string }) => entry.version),
    ['0.74.0', '0.73.14'],
  );
  assert.deepEqual(
    notes[0].changes.map((change: { message: string }) => change.message),
    ['Friends can join in the middle of a match.', 'Reconnecting is more reliable.'],
  );
  assert.equal(bump('Duplicate release').status, 1);
  assert.equal(git('tag', '--list'), 'v0.74.0');
});

test('a release without notes leaves the tree clean and a fix without a conventional title still ships', (t) => {
  const { add, bump, git } = repo(t);
  add('Give late joining a bounded pause');
  const source = git('rev-parse', 'HEAD');
  assert.match(bump('  \n  ').stderr, /at least one player-facing release note/);
  assert.equal(git('rev-parse', 'HEAD'), source);
  assert.equal(git('status', '--short'), '');
  assert.equal(bump('Players can get past a stuck join pause.').status, 0);
  assert.equal(git('tag', '--list'), 'v0.73.15');
});

test('a fresh release rejects stale main while a retry selects the already-published version', (t) => {
  const { cwd, add, run, bump, git } = repo(t);
  add('fix: pause');
  const source = git('rev-parse', 'HEAD');
  assert.equal(bump('Fixed a long pause.').status, 0);
  const published = git('rev-parse', 'HEAD');
  add('fix: merged after the batch');
  const newerTip = git('rev-parse', 'HEAD');
  const output = join(cwd, 'action-output');
  const select = (sha: string, attempt: string) =>
    run('bash', ['-ec', workflowStep('Select the release commit')], {
      RELEASE_SHA: sha,
      GITHUB_RUN_ATTEMPT: attempt,
      GITHUB_OUTPUT: output,
    });
  assert.equal(select(source, '1').status, 1);
  assert.equal(git('rev-parse', 'HEAD'), newerTip);
  assert.equal(select(newerTip, '1').status, 0);
  assert.equal(readFileSync(output, 'utf8'), 'bump=true\n');
  assert.equal(select(source, '2').status, 0);
  assert.equal(git('rev-parse', 'HEAD'), published);
  assert.equal(readFileSync(output, 'utf8'), 'bump=true\nbump=false\n');
});

test('each required check must pass for the selected main SHA', (t) => {
  const { run, git } = repo(t);
  const gate = `
    gh() {
      [[ "$*" == *"--branch main --event push --commit $RELEASE_SHA "* ]] || return 2
      if [[ "$*" == *"--workflow $MISSING_CHECK "* ]]; then return 0; fi
      echo success
    }
    ${workflowStep('Require successful main checks')}
  `;
  const env = { RELEASE_SHA: git('rev-parse', 'HEAD'), GITHUB_REPOSITORY: 'test/kaillera-next' };
  assert.equal(run('bash', ['-ec', gate], { ...env, MISSING_CHECK: 'none' }).status, 0);
  for (const workflow of ['lint.yml', 'browser.yml', 'capture-privacy.yml']) {
    const result = run('bash', ['-ec', gate], { ...env, MISSING_CHECK: workflow });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes(`${workflow} has no successful run`));
  }
});
