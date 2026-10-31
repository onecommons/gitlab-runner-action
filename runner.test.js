const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TOML = require('@iarna/toml');
const { spawnSync } = require('node:child_process');
const { readOptions, Runner } = require('./runner');

function inputs(values = {}) {
  return {
    getInput: name => ({ name: 'test runner', 'runner-token': 'glrt-test', ...values }[name] || ''),
    setSecret() {}, warning() {}, info() {}, saveState() {}
  };
}

function fixture(t, values = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const core = inputs(values);
  const options = readOptions(core, { RUNNER_TEMP: tempDir });
  const calls = [];
  const states = [];
  core.saveState = (name, value) => states.push(JSON.parse(value));
  let clock = 0;
  const dependencies = {
    core,
    exec: async (command, args, settings) => {
      calls.push({ command, args, settings });
      if (args.includes('register')) {
        fs.writeFileSync(path.join(options.configDir, 'config.toml'), TOML.stringify({
          concurrent: 1,
          runners: [{ name: options.name, token: 'glrt-private', executor: 'docker' }]
        }));
      }
      return 0;
    },
    getExecOutput: async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0, stdout: args[0] === 'inspect' ? 'true\n' : '', stderr: '' };
    },
    now: () => clock,
    sleep: async ms => { clock += ms; }
  };
  const runner = new Runner(options, dependencies);
  return { runner, options, dependencies, calls, states };
}

test('modern tokens use environment authentication and omit server-side registration flags', t => {
  const { runner } = fixture(t, { 'tag-list': 'example-runner' });
  const { args, tokenEnv } = runner.registrationArguments();
  assert.equal(tokenEnv, 'CI_SERVER_TOKEN');
  for (const flag of ['--registration-token', '--tag-list', '--locked=false', '--access-level=not_protected']) {
    assert.ok(!args.includes(flag), flag);
  }
  assert.ok(!args.includes('glrt-test'));
});

test('glrt tokens still work through the original registration-token input', t => {
  const { runner } = fixture(t, { 'runner-token': '', 'registration-token': 'glrt-old-input' });
  assert.equal(runner.registrationArguments().tokenEnv, 'CI_SERVER_TOKEN');
});

test('legacy registration keeps tags and passes boolean flags without literal quotes', t => {
  const { runner } = fixture(t, {
    'runner-token': '', 'registration-token': 'legacy', 'tag-list': 'example-runner', 'run-untagged': 'false'
  });
  const { args, tokenEnv } = runner.registrationArguments();
  assert.equal(tokenEnv, 'REGISTRATION_TOKEN');
  assert.ok(args.includes('--tag-list'));
  assert.ok(args.includes('--locked=false'));
  assert.ok(args.includes('--run-untagged=false'));
  assert.ok(!args.some(arg => arg.includes('"')));
});

test('invalid inputs fail before registering a runner', () => {
  for (const values of [
    { concurrent: '0' }, { concurrent: '2jobs' }, { timeout: '-1' },
    { 'docker-privileged': 'yes' }, { 'registration-token': 'also-set' },
    { 'runner-token': '', 'registration-token': '' },
    { 'runner-token': '', 'registration-token': 'legacy', 'tag-list': '' },
    { 'pipeline-url': 'https://gitlab.example/api/v4/projects/1/pipelines/2', 'exit-after-job': 'true' },
    { 'pipeline-url': 'gitlab.example/api/v4/projects/1/pipelines/2' }
  ]) assert.throws(() => readOptions(inputs(values)));
});

test('start creates private isolated config, persists no secrets and sets actual concurrency', async t => {
  const { runner, options, calls, states } = fixture(t, { concurrent: '2', 'network-per-build': 'true' });
  await runner.start();
  const configPath = path.join(options.configDir, 'config.toml');
  assert.equal(TOML.parse(fs.readFileSync(configPath, 'utf8')).concurrent, 2);
  assert.equal(fs.statSync(options.configDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(states).includes('glrt-'));
  const registration = calls.find(call => call.args.includes('register'));
  assert.equal(registration.settings.env.CI_SERVER_TOKEN, 'glrt-test');
  const ffIndex = registration.args.indexOf('FF_NETWORK_PER_BUILD=1');
  assert.equal(registration.args[ffIndex - 1], '--env');
  assert.ok(registration.args.includes('--docker-privileged=true'));
  await runner.cleanup();
  assert.equal(fs.existsSync(options.configDir), false);
  const count = calls.length;
  await runner.cleanup();
  assert.equal(calls.length, count);
});

test('timed service waits until its deadline and detects a stopped runner', async t => {
  const { runner, calls } = fixture(t, { timeout: '7' });
  await runner.start();
  await runner.wait();
  assert.equal(calls.filter(call => call.args[0] === 'inspect').length, 3);
  runner.output = async () => ({ exitCode: 0, stdout: 'false', stderr: '' });
  await assert.rejects(runner.wait(), /stopped unexpectedly/);
});

test('timed service detects a runner exit during the final polling interval', async t => {
  const { runner, options, dependencies } = fixture(t, { timeout: '7' });
  await runner.start();
  let inspections = 0;
  runner.output = async (_, args) => {
    if (args[0] === 'inspect') {
      inspections += 1;
      return { exitCode: 0, stdout: inspections < 3 ? 'true' : 'false', stderr: '' };
    }
    return dependencies.getExecOutput(_, args);
  };
  await assert.rejects(runner.wait(), /stopped unexpectedly/);
  assert.equal(inspections, 3);
  assert.equal(options.timeout, 7);
});

test('single-job mode forces concurrency one and exits for successful or failed jobs', async t => {
  for (const message of ['Job succeeded', 'WARNING: Job failed: exit code 1']) {
    const { runner, options, calls } = fixture(t, { 'exit-after-job': 'true', concurrent: '4' });
    assert.equal(options.concurrent, 1);
    await runner.start();
    const run = calls.find(call => call.args[0] === 'run' && call.args.includes('--detach'));
    assert.deepEqual(run.args.slice(-3), ['run', '--max-builds', '1']);
    runner.output = async (_, args) => ({
      exitCode: 0, stdout: args[0] === 'inspect' ? 'true' : '',
      stderr: args[0] === 'logs' ? message : ''
    });
    await runner.wait();
  }
});

test('single-job mode accepts only a completed job as an expected runner exit', async t => {
  const { runner, calls } = fixture(t, { 'exit-after-job': 'true' });
  await runner.start();
  const run = calls.find(call => call.args[0] === 'run' && call.args.includes('--detach'));
  assert.deepEqual(run.args.slice(-3), ['run', '--max-builds', '1']);

  runner.output = async (_, args) => ({
    exitCode: 0, stdout: args[0] === 'inspect' ? 'false' : 'Job failed: exit code 1', stderr: ''
  });
  await runner.wait();

  runner.output = async (_, args) => ({
    exitCode: 0, stdout: args[0] === 'inspect' ? 'false' : 'runner stopped', stderr: ''
  });
  await assert.rejects(runner.wait(), /stopped unexpectedly/);
});

const PIPELINE = 'https://gitlab.example/api/v4/projects/1/pipelines/2';

// Answers each poll with the next of `replies`: a status, an HTTP code, or an Error.
function pipelineReplies(runner, replies, polls) {
  runner.fetch = async url => {
    assert.equal(url, PIPELINE);
    polls.push(runner.now());
    const reply = replies[Math.min(polls.length, replies.length) - 1];
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'number') return { ok: false, status: reply };
    return { ok: true, status: 200, json: async () => ({ status: reply }) };
  };
}

test('pipeline mode exits once the pipeline succeeds, polling once a minute', async t => {
  const { runner } = fixture(t, { 'pipeline-url': PIPELINE, timeout: '3600' });
  await runner.start();
  const polls = [];
  pipelineReplies(runner, ['pending', 'running', 'success'], polls);
  await runner.wait();
  assert.deepEqual(polls, [0, 60000, 120000]);
});

test('pipeline mode fails when the pipeline ends any other way', async t => {
  for (const status of ['failed', 'canceled', 'skipped', 'manual']) {
    const { runner } = fixture(t, { 'pipeline-url': PIPELINE });
    await runner.start();
    pipelineReplies(runner, ['running', status], []);
    await assert.rejects(runner.wait(), new RegExp(`ended ${status}`));
  }
});

test('pipeline mode retries failed requests unless retrying cannot help', async t => {
  const { runner } = fixture(t, { 'pipeline-url': PIPELINE });
  await runner.start();
  const polls = [];
  pipelineReplies(runner, [new Error('ECONNRESET'), 502, 429, 'success'], polls);
  await runner.wait();
  assert.equal(polls.length, 4);

  pipelineReplies(runner, [404], []);
  await assert.rejects(runner.wait(), /HTTP 404/);
});

test('pipeline mode fails when the pipeline outlasts the timeout', async t => {
  const { runner } = fixture(t, { 'pipeline-url': PIPELINE, timeout: '150' });
  await runner.start();
  const polls = [];
  pipelineReplies(runner, ['running'], polls);
  await assert.rejects(runner.wait(), /did not finish within 150 seconds/);
  assert.deepEqual(polls, [0, 60000, 120000, 150000]);
});

test('registration and startup failures still allow scoped unregister cleanup', async t => {
  for (const stage of ['register', '--detach']) {
    const { runner, options, dependencies, calls } = fixture(t);
    runner.exec = async (...args) => {
      await dependencies.exec(...args);
      if (args[1].includes(stage)) throw new Error(`failed ${stage}`);
    };
    await assert.rejects(runner.start(), /failed/);
    await runner.cleanup();
    assert.ok(calls.some(call => call.args.includes('unregister')));
    assert.equal(fs.existsSync(options.configDir), false);
  }
});

test('a stop failure cannot skip unregister; the post hook can retry cleanup', async t => {
  const { runner, options, dependencies, calls } = fixture(t);
  await runner.start();
  runner.output = async (...args) => {
    if (args[1][0] === 'stop') throw new Error('stop failed');
    return dependencies.getExecOutput(...args);
  };
  await assert.rejects(runner.cleanup(), /stop failed/);
  assert.ok(calls.some(call => call.args.includes('unregister')));
  assert.equal(fs.existsSync(options.configDir), true);
  runner.output = dependencies.getExecOutput;
  await runner.cleanup();
  assert.equal(fs.existsSync(options.configDir), false);
});

test('post-job cleanup uses saved state without needing the registration secret', async t => {
  const { runner, states, options, dependencies } = fixture(t);
  await runner.start();
  assert.equal(states[0].token, undefined);
  await new Runner(states[0], dependencies).cleanup();
  assert.equal(fs.existsSync(options.configDir), false);
});

test('bundled entrypoints load, reject missing credentials, and allow an empty post hook', () => {
  const main = spawnSync(process.execPath, ['dist/index.js'], { encoding: 'utf8', env: {} });
  assert.equal(main.status, 1);
  assert.match(main.stdout + main.stderr, /runner-token or registration-token is required/);
  const post = spawnSync(process.execPath, ['dist/post/index.js'], { encoding: 'utf8', env: {} });
  assert.equal(post.status, 0, post.stdout + post.stderr);
});
