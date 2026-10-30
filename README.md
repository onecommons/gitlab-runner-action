# Gitlab Runner Action
This action starts a gitlab runner and registers it with the given gitlab instance.
It can be configured to exit after the first job it receives or after a timeout.

## Runner authentication tokens

For a `glrt-` runner authentication token, create the project or group runner in
GitLab first. Set its tags, protected access, and whether it accepts untagged jobs
there. These settings cannot be changed during registration with an authentication
token. The existing `registration-token` input also recognizes `glrt-` tokens.

```yaml
- name: Host a GitLab runner
  uses: onecommons/gitlab-runner-action@main
  with:
    runner-token: ${{ secrets.GITLAB_RUNNER_TOKEN }}
    gitlab-instance: https://gitlab.com/
    name: runner-${{ github.run_id }}-${{ github.run_attempt }}
    concurrent: '1'
    network-per-build: 'true'
    timeout: '10800'
```

This action needs a Linux host with Docker and access to `/var/run/docker.sock`.
It uses Node.js 24. Set the enclosing job's timeout longer than the action's
timeout to allow cleanup. Timed mode stays active for the configured duration;
it does not monitor the GitLab pipeline result. Single-job mode exits after a
successful or failed job, and does not wait for an entire pipeline.

Each invocation uses a private config directory and a unique container name.
Cleanup stops the container and unregisters its runner manager on completion or
failure. A post-job hook retries cleanup after cancellation. With authentication
tokens, the server-side runner remains available for subsequent workflow runs.


## Action Inputs

| Input Name | Description | Required | Enum Values | Default Value |
|-----------------|-------------|---------------|---------------|---------------|
| `gitlab-instance` | Gitlab instance | No | N/A | https://gitlab.com/ |
| `runner-token` | Runner authentication token; use this or registration-token | No | N/A | N/A |
| `registration-token` | Legacy registration token, or a glrt- token for compatibility | No | N/A | N/A |
| `name` | Runner name | Yes | N/A | N/A |
| `tag-list` | Runner tags; required only with legacy registration tokens | No | N/A | N/A |
| `docker-image` | Default job image, overridden by the GitLab job's image | No | N/A | docker:28.5.1 |
| `runner-image` | GitLab Runner image; accepts a version or digest | No | N/A | gitlab/gitlab-runner:latest |
| `docker-privileged` | Run job and service containers in privileged mode | No | true or false | true |
| `network-per-build` | Create a separate Docker network for each GitLab job | No | true or false | false |
| `run-untagged` | Parameter that allows or not to pick untagged jobs | No | true or false | true |
| `access-level` | Parameter to create or not a protected runner | No | ref_protected or not_protected | not_protected |
| `concurrent` | Maximum number of jobs that can run concurrently (automatically set to 1 if exit-after-job is true) | No | N/A | 4 |
| `timeout` | Timeout in seconds for how long the runner should stay active (ignored if exit-after-job is true) | No | N/A | 3600 |
| `exit-after-job` | Exit after first job completes instead of waiting for timeout (forces concurrent to 1) | No | true or false | false |

## Example Workflows

### Exit After Single Job
Exit immediately after completing one job (concurrent is automatically set to 1):
```yaml
name: Gitlab Runner Service
on: [repository_dispatch]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Gitlab Runner
        uses: onecommons/gitlab-runner-action@main
        with:
          registration-token: "${{ secrets.GITLAB_RUNNER_TOKEN }}"
          name: ${{ github.run_id }}
          tag-list: "crosscicd"
          exit-after-job: "true"  # concurrent will be automatically set to 1
```

### Long-running Runner with Concurrent Jobs
Run multiple jobs concurrently with a 2-hour timeout:
```yaml
name: Gitlab Runner Service
on: [repository_dispatch]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 130  # Slightly longer than timeout for cleanup
    steps:
      - name: Gitlab Runner
        uses: onecommons/gitlab-runner-action@main
        with:
          registration-token: "${{ secrets.GITLAB_RUNNER_TOKEN }}"
          name: ${{ github.run_id }}
          tag-list: "crosscicd"
          concurrent: "2"
          timeout: "7200"  # 2 hours in seconds
```

### Basic Example with Space Cleanup
This example includes a step for cleaning space and gitlab runner to provide up to 60mb for the runner.

```yaml
name: Gitlab Runner Service
on: [repository_dispatch]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Maximize Build Space
        uses: easimon/maximize-build-space@master
        with:
          root-reserve-mb: 512
          swap-size-mb: 1024
          remove-dotnet: 'true'
          remove-android: 'true'
          remove-haskell: 'true'

      - name: Gitlab Runner
        uses: onecommons/gitlab-runner-action@main
        with:
          registration-token: "${{ github.event.client_payload.registration_token }}"
          docker-image: "docker:19.03.12"
          name: ${{ github.run_id }}
          tag-list: "crosscicd"
```

### Triggering job via API

```bash
curl -X POST \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/owner/repo/dispatches \
  -d '{
    "event_type": "run-gitlab-runner",
    "client_payload": {
      "timeout": "3600",
      "concurrent": "2",
      "tag_list": "my-custom-tag"
    }
  }'
```
