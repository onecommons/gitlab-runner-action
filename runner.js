const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TOML = require('@iarna/toml');

function readOptions(actionCore, env = process.env) {
  const input = (name, fallback = '') => actionCore.getInput(name) || fallback;
  const integer = (name, fallback) => {
    const value = input(name, fallback);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`${name} must be a positive integer`);
    }
    return Number(value);
  };
  const boolean = (name, fallback) => {
    const value = input(name, fallback).toLowerCase();
    if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
    return value === 'true';
  };

  const runnerToken = input('runner-token');
  const registrationToken = input('registration-token');
  if (runnerToken && registrationToken) {
    throw new Error('Set runner-token or registration-token, not both');
  }
  const token = runnerToken || registrationToken;
  if (!token) throw new Error('runner-token or registration-token is required');
  actionCore.setSecret(token);
  const modern = Boolean(runnerToken) || token.startsWith('glrt-');
  const tags = input('tag-list');
  if (!modern && !tags) throw new Error('tag-list is required with a legacy registration token');
  if (modern && tags) {
    actionCore.warning('tag-list is ignored with a runner authentication token; configure tags in GitLab');
  }
  const name = input('name');
  if (!name) throw new Error('name is required');
  const exitAfterJob = boolean('exit-after-job', 'false');
  const concurrent = integer('concurrent', '4');
  const accessLevel = input('access-level', 'not_protected');
  if (!['not_protected', 'ref_protected'].includes(accessLevel)) {
    throw new Error('access-level must be not_protected or ref_protected');
  }

  return {
    token, modern, tags, name, accessLevel,
    url: input('gitlab-instance', 'https://gitlab.com/'),
    dockerImage: input('docker-image', 'docker:28.5.1'),
    runnerImage: input('runner-image', 'gitlab/gitlab-runner:latest'),
    privileged: boolean('docker-privileged', 'true'),
    networkPerBuild: boolean('network-per-build', 'false'),
    runUntagged: boolean('run-untagged', 'true'),
    concurrent: exitAfterJob ? 1 : concurrent,
    timeout: integer('timeout', '3600'),
    exitAfterJob,
    tempDir: env.RUNNER_TEMP || os.tmpdir(),
    uid: process.getuid(),
    gid: process.getgid()
  };
}

class Runner {
  constructor(options, dependencies = {}) {
    this.options = options;
    this.core = dependencies.core;
    this.exec = dependencies.exec;
    this.output = dependencies.getExecOutput;
    this.sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = dependencies.now || Date.now;
  }

  configMount() {
    return ['--volume', `${this.options.configDir}:/etc/gitlab-runner`];
  }

  registrationArguments() {
    const o = this.options;
    const tokenEnv = o.modern ? 'CI_SERVER_TOKEN' : 'REGISTRATION_TOKEN';
    const args = ['run', '--rm', ...this.configMount(),
      '--user', `${o.uid}:${o.gid}`, '--env', 'HOME=/tmp', '--env', tokenEnv,
      o.runnerImage, 'register', '--config', '/etc/gitlab-runner/config.toml',
      '--non-interactive', '--executor', 'docker', '--docker-image', o.dockerImage,
      '--url', o.url, '--name', o.name, '--request-concurrency', String(o.concurrent),
      `--docker-privileged=${o.privileged}`];
    if (!o.modern) {
      args.push('--tag-list', o.tags, '--locked=false',
        `--access-level=${o.accessLevel}`, `--run-untagged=${o.runUntagged}`);
    }
    if (o.networkPerBuild) args.push('--environment', 'FF_NETWORK_PER_BUILD=1');
    return { args, tokenEnv };
  }

  async start() {
    const o = this.options;
    o.configDir = fs.mkdtempSync(path.join(o.tempDir, 'gitlab-runner-action-'));
    o.containerName = path.basename(o.configDir);
    // Save only cleanup coordinates; the runner token belongs in its private config.
    this.core.saveState('runner', JSON.stringify({
      configDir: o.configDir, containerName: o.containerName,
      name: o.name, runnerImage: o.runnerImage, uid: o.uid, gid: o.gid
    }));
    const { args, tokenEnv } = this.registrationArguments();
    await this.exec('docker', args, { env: { ...process.env, [tokenEnv]: o.token } });
    const configPath = path.join(o.configDir, 'config.toml');
    const config = TOML.parse(fs.readFileSync(configPath, 'utf8'));
    config.concurrent = o.concurrent;
    fs.writeFileSync(configPath, TOML.stringify(config), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    const runArgs = ['run', '--detach', '--name', o.containerName,
      ...this.configMount(), '--volume', '/var/run/docker.sock:/var/run/docker.sock',
      o.runnerImage];
    if (o.exitAfterJob) runArgs.push('run', '--max-builds', '1');
    await this.exec('docker', runArgs);
  }

  async wait() {
    const o = this.options;
    const deadline = o.exitAfterJob ? Infinity : this.now() + o.timeout * 1000;
    while (this.now() < deadline) {
      const state = await this.output('docker', ['inspect', '--format', '{{.State.Running}}',
        o.containerName], { silent: true });
      if (state.stdout.trim() !== 'true') {
        if (o.exitAfterJob && await this.jobCompleted(o.containerName)) return;
        throw new Error('The GitLab runner container stopped unexpectedly');
      }
      if (o.exitAfterJob) {
        if (await this.jobCompleted(o.containerName)) return;
      }
      await this.sleep(Math.min(5000, deadline - this.now()));
    }
    const state = await this.output('docker', ['inspect', '--format', '{{.State.Running}}',
      o.containerName], { silent: true });
    if (state.stdout.trim() !== 'true') throw new Error('The GitLab runner container stopped unexpectedly');
  }

  async jobCompleted(containerName) {
    const logs = await this.output('docker', ['logs', '--tail', '200', containerName], { silent: true });
    return /\bJob (succeeded|failed)\b/i.test(logs.stdout + logs.stderr);
  }

  async cleanup() {
    const o = this.options;
    if (!o.configDir || !fs.existsSync(o.configDir)) return;
    const errors = [];
    // Try every cleanup operation even when stopping the container fails.
    for (const args of [['stop', '--time', '60', o.containerName], ['rm', '--force', o.containerName]]) {
      try {
        const result = await this.output('docker', args, { silent: true, ignoreReturnCode: true });
        if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) {
          throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
    const configPath = path.join(o.configDir, 'config.toml');
    try {
      if (fs.existsSync(configPath)) {
        // This config is private to the action; root also handles rotated credentials.
        await this.exec('docker', ['run', '--rm', ...this.configMount(), o.runnerImage,
          'unregister', '--config', '/etc/gitlab-runner/config.toml', '--all-runners']);
      }
    } catch (error) {
      errors.push(`Unregistering runner failed: ${error.message}`);
    }
    if (errors.length) throw new Error(errors.join('; '));
    fs.rmSync(o.configDir, { recursive: true, force: true });
  }
}

module.exports = { readOptions, Runner };
