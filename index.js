const { readOptions, Runner } = require('./runner');

async function main(core, execution) {
  let runner;
  try {
    runner = new Runner(readOptions(core), { core, ...execution });
    await runner.start();
    await runner.wait();
  } catch (error) {
    core.setFailed(error.message);
  } finally {
    if (runner) {
      try {
        await runner.cleanup();
      } catch (error) {
        core.setFailed(error.message);
      }
    }
  }
}

Promise.all([import('@actions/core'), import('@actions/exec')])
  .then(([core, execution]) => main(core, execution))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
