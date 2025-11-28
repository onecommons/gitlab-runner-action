const core = require('@actions/core');
const { exec } = require('@actions/exec');
const path = require("path");
const fs = require("fs");
const TOML = require('@iarna/toml');

async function registerRunnerCmd(concurrent) {
  let cmdArgs = [];
  cmdArgs.push(`--rm`)
  cmdArgs.push(`-v`, `/srv/gitlab-runner/config:/etc/gitlab-runner`)
  cmdArgs.push(`gitlab/gitlab-runner`)
  cmdArgs.push(`register`)
  cmdArgs.push(`--non-interactive`)
  cmdArgs.push(`--executor`, `docker`)
  cmdArgs.push(`--docker-image`, core.getInput('docker-image'))
  cmdArgs.push(`--url`, core.getInput('gitlab-instance'))
  cmdArgs.push(`--registration-token`, core.getInput('registration-token'))
  cmdArgs.push(`--name`, core.getInput('name'))
  cmdArgs.push(`--tag-list`, core.getInput('tag-list'))
  cmdArgs.push(`--request-concurrency`, concurrent)
  cmdArgs.push(`--docker-privileged`, true)
  cmdArgs.push(`--locked="false"`)
  cmdArgs.push(`--access-level="${core.getInput('access-level')}"`)
  cmdArgs.push(`--run-untagged="${core.getInput('run-untagged')}"`)

  await exec('docker run', cmdArgs);
}

async function setConcurrent(concurrent) {
  try {
    const tempFile = path.join(__dirname, 'config.toml');
    const configPath = '/etc/gitlab-runner/config.toml';

    core.info(`Setting concurrent to ${concurrent}`);

    // Copy config.toml from the Docker volume to a temp file we can read
    let copyOutArgs = ['--rm', '-v', '/srv/gitlab-runner/config:/etc/gitlab-runner', '-v', `${__dirname}:/workspace`, 'alpine', 'cp', configPath, '/workspace/config.toml'];
    await exec('docker run', copyOutArgs);
    core.info(`Copied config file to temp location`);

    // Read and parse the TOML file
    const configContent = fs.readFileSync(tempFile, 'utf8');
    const config = TOML.parse(configContent);
    core.info(`Parsed TOML successfully`);

    // Update the concurrent value
    config.concurrent = parseInt(concurrent);
    core.info(`Updated concurrent to ${config.concurrent}`);

    // Stringify and write to temp file
    const newContent = TOML.stringify(config);
    fs.writeFileSync(tempFile, newContent, 'utf8');
    core.info(`Wrote updated config to temp file`);

    // Copy temp file back to the Docker volume
    let copyInArgs = ['--rm', '-v', '/srv/gitlab-runner/config:/etc/gitlab-runner', '-v', `${__dirname}:/workspace`, 'alpine', 'cp', '/workspace/config.toml', configPath];
    await exec('docker run', copyInArgs);
    core.info(`Copied config file back to volume`);

    // Clean up temp file
    fs.unlinkSync(tempFile);
  } catch (error) {
    core.error(`Error in setConcurrent: ${error.message}`);
    core.error(`Stack trace: ${error.stack}`);
    throw error;
  }
}

async function unregisterRunnerCmd() {
  let cmdArgs = [];
  cmdArgs.push(`--rm`)
  cmdArgs.push(`-v`, `/srv/gitlab-runner/config:/etc/gitlab-runner`)
  cmdArgs.push(`gitlab/gitlab-runner`)
  cmdArgs.push(`unregister`)
  cmdArgs.push(`--name`, core.getInput('name'))

  await exec('docker run', cmdArgs);
}

async function startRunnerCmd() {
  let cmdArgs = []
  cmdArgs.push(`-d`)
  cmdArgs.push(`--name`, `gitlab-runner`)
  cmdArgs.push(`--restart`, `always`)
  cmdArgs.push(`-v`, `/srv/gitlab-runner/config:/etc/gitlab-runner`)
  cmdArgs.push(`-v`, `/var/run/docker.sock:/var/run/docker.sock`)
  cmdArgs.push(`gitlab/gitlab-runner`)

  await exec('docker run', cmdArgs);
}

async function stopRunnerCmd() {
  let cmdArgs = []
  cmdArgs.push(`gitlab-runner`)

  await exec('docker stop ', cmdArgs);
  await exec('docker rm ', cmdArgs);
}

async function waitTimeout(){
  const timeout = parseInt(core.getInput('timeout')) * 1000; // Convert to milliseconds
  return new Promise(resolve => setTimeout(resolve, timeout));
}

async function checkJob(){
  await exec(`${path.resolve(__dirname, "dist")}/check-job.sh`)
}

async function registerRunner() {
  try{
    const exitAfterJob = core.getInput('exit-after-job') === 'true';
    const concurrent = exitAfterJob ? '1' : core.getInput('concurrent');
    await registerRunnerCmd(concurrent)
    await setConcurrent(concurrent)
    await startRunnerCmd()
    if (exitAfterJob) {
      await checkJob()
    } else {
      await waitTimeout()
    }
  }finally{
    await unregisterRunner()
  }
}

async function unregisterRunner() {
  await stopRunnerCmd()
  await unregisterRunnerCmd()
}

registerRunner()