const { Runner } = require('./runner');

async function cleanup(core, execution) {
  try {
    const state = core.getState('runner');
    if (state) await new Runner(JSON.parse(state), { core, ...execution }).cleanup();
  } catch (error) {
    core.setFailed(error.message);
  }
}

Promise.all([import('@actions/core'), import('@actions/exec')])
  .then(([core, execution]) => cleanup(core, execution))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
