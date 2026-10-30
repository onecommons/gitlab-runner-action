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
    setSecret() {}, warning() {}, saveState() {}
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
    { 'runner-token': '', 'registration-token': 'legacy', 'tag-list': '' }
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
  assert.ok(registration.args.includes('FF_NETWORK_PER_BUILD=1'));
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
  assert.equal(calls.filter(call => call.args[0] === 'inspect').length, 2);
  runner.output = async () => ({ exitCode: 0, stdout: 'false', stderr: '' });
  await assert.rejects(runner.wait(), /stopped unexpectedly/);
});

test('single-job mode forces concurrency one and exits for successful or failed jobs', async t => {
  for (const message of ['Job succeeded', 'WARNING: Job failed: exit code 1']) {
    const { runner, options } = fixture(t, { 'exit-after-job': 'true', concurrent: '4' });
    assert.equal(options.concurrent, 1);
    await runner.start();
    runner.output = async (_, args) => ({
      exitCode: 0, stdout: args[0] === 'inspect' ? 'true' : '',
      stderr: args[0] === 'logs' ? message : ''
    });
    await runner.wait();
  }
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
