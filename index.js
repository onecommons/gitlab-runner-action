const core = require('@actions/core');
const { exec } = require('@actions/exec');
const path = require("path");
const fs = require("fs");
const TOML = require('@iarna/toml');

async function registerRunnerCmd(concurrent) {
  const configDir = process.env.RUNNER_TEMP || '/tmp';

  let cmdArgs = [];
  cmdArgs.push(`--rm`)
  cmdArgs.push(`-v`, `${configDir}:/etc/gitlab-runner`)
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

  // Fix permissions on the config file so Node.js can read/write it
  let chmodArgs = ['--rm', '-v', `${configDir}:/etc/gitlab-runner`, 'alpine', 'chmod', '666', '/etc/gitlab-runner/config.toml'];
  await exec('docker run', chmodArgs);
}

async function setConcurrent(concurrent) {
  try {
    const configDir = process.env.RUNNER_TEMP || '/tmp';
    const configPath = path.join(configDir, 'config.toml');

    core.info(`Setting concurrent to ${concurrent} in ${configPath}`);

    // Read and parse the TOML file created by registerRunnerCmd()
    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = TOML.parse(configContent);
    core.info(`Parsed TOML successfully`);

    // Update the concurrent value
    config.concurrent = parseInt(concurrent);
    core.info(`Updated concurrent to ${config.concurrent}`);

    // Stringify and write it back
    const newContent = TOML.stringify(config);
    fs.writeFileSync(configPath, newContent, 'utf8');
    core.info(`Wrote updated config file successfully`);
  } catch (error) {
    core.error(`Error in setConcurrent: ${error.message}`);
    throw error;
  }
}

async function unregisterRunnerCmd() {
  const configDir = process.env.RUNNER_TEMP || '/tmp';

  let cmdArgs = [];
  cmdArgs.push(`--rm`)
  cmdArgs.push(`-v`, `${configDir}:/etc/gitlab-runner`)
  cmdArgs.push(`gitlab/gitlab-runner`)
  cmdArgs.push(`unregister`)
  cmdArgs.push(`--name`, core.getInput('name'))

  await exec('docker run', cmdArgs);
}

async function startRunnerCmd() {
  const configDir = process.env.RUNNER_TEMP || '/tmp';

  let cmdArgs = []
  cmdArgs.push(`-d`)
  cmdArgs.push(`--name`, `gitlab-runner`)
  cmdArgs.push(`--restart`, `always`)
  cmdArgs.push(`-v`, `${configDir}:/etc/gitlab-runner`)
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