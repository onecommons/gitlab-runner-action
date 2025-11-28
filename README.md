# Gitlab Runner Action
This action starts a gitlab runner and registers it with the given gitlab instance.
It can be configured to exit after the first job it receives or after a timeout.


## Action Inputs

| Input Name | Description | Required | Enum Values | Default Value |
|-----------------|-------------|---------------|---------------|---------------|
| `gitlab-instance` | Gitlab instance | No | N/A | https://gitlab.com/ |
| `registration-token` | Registration token | Yes | N/A | N/A |
| `name` | Runner name | Yes | N/A | N/A |
| `tag-list` | Tag list to bind with the runner | Yes | N/A | N/A |
| `docker-image` | Docker image used by runner | No | N/A | docker:19.03.12 |
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
