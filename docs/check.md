# Review committed changes with `dhruv check`

`dhruv check --base <git-ref>` reviews the commits on your branch that are not on the base branch. It sends the changed lines to an Ollama model, keeps only the findings it can place on a changed line, and reports what it reviewed and what it skipped. The same command runs on a laptop and in CI.

Findings are advisory. They never change the exit code, and a run with no findings does not prove the change is correct.

## Run it locally

You need Node.js 20.19 or newer, Git, and an Ollama server that has the model you want to use.

```bash
npm install -g @rahul05ranjan/dhruv-cli
ollama pull qwen2.5-coder:7b

git fetch origin
dhruv check --base origin/main --model qwen2.5-coder:7b
```

Run it from anywhere inside the repository. Commit your work first: `check` reads commits, so staged and unstaged edits are not reviewed.

```text
Dhruv check: origin/main (3ea120d02fdd) .. HEAD (d42be07cca72), merge base 3ea120d02fdd
Base commit 3ea120d02fdd78503dff98c6e627c520b6d03de0
Merge base 3ea120d02fdd78503dff98c6e627c520b6d03de0
Head commit d42be07cca7202e9e71f87a3901bde4c5fb25fc3
Model qwen2.5-coder:7b
Policy .dhruv-check.json

Analyzed 1 of 3 changed files.
1 finding: 1 high.

[HIGH] src/payments/refund.ts:2
  Reason: Audit entry is written before the refund succeeds
  Evidence: audit(reason) runs before gateway.refund(amount), so a failed refund still leaves an audit record
  Recommendation: Write the audit entry after the gateway call succeeds, or record the failure as well

Omitted 1 model candidate: 0 invalid, 1 not on a changed line.

Not analyzed (2): 1 ignored, 1 unsupported
  README.md  (unsupported)
  dist/bundle.js  (ignored)
```

Add `--json` to get the same result as one JSON object on stdout, and `--strict-coverage` to exit 2 when relevant source was skipped:

```bash
dhruv check --base origin/main --model qwen2.5-coder:7b --json --strict-coverage > dhruv-check.json
```

### What is reviewed

- **The range.** `check` resolves `--base` and `HEAD` to commits, finds their merge base, and reviews the changes from that merge base up to `HEAD`. Commits that landed on the base branch after you branched are not part of the review. The result names all three commits.
- **Changed lines only.** The model receives the changed hunks of each analyzed file with ten lines of context, and the file paths. Nothing else from the repository is sent. A finding must sit on a line the range added or modified.
- **Source files only.** Files are analyzed when their extension is one of `js`, `ts`, `jsx`, `tsx`, `py`, `java`, `cpp`, `c`, `go`, `rs`, `rb`, `php`. Every other changed file is listed as `unsupported` and is not sent.
- **Not removals.** A file whose change only removes lines has no changed line to review, so it is listed as `no-line-changes` and is not sent. If a commit deletes a guard clause and touches nothing else in that file, `check` does not see it.

### `check` or `review --diff`

| | `dhruv check --base <git-ref>` | `dhruv review --diff <path>` |
| --- | --- | --- |
| Reviews | Committed changes from the merge base of the base ref and `HEAD` | Uncommitted edits in the working tree, as `git diff` shows them (changes already staged are left out) |
| Output | Findings with a path, line and severity, plus coverage; text or versioned JSON | The model's prose review |
| Scope control | Checked-in policy, size limits, exclusion report | None |
| Loads `plugins/` | Never | Yes |
| Use it for | A branch before or during a pull request, and CI | A quick look at edits you have not committed yet |

## Choose the model and the Ollama endpoint

`check` uses the same model and endpoint settings as every other Dhruv command.

| Setting | How to set it | Default |
| --- | --- | --- |
| Model | `--model <name>`; otherwise `model` in `.dhruv-config.json` in the directory you run from or, when that file does not exist, in `~/.config/dhruv/config.json` | `gemma3:270m` |
| Ollama endpoint | `OLLAMA_HOST` environment variable, as a URL with its scheme, for example `http://ollama.internal:11434` | `http://127.0.0.1:11434` |
| Request timeout | `--timeout <milliseconds>`; otherwise `timeoutMs` in the same configuration file | `45000` |

To use an Ollama service your company runs, set `OLLAMA_HOST` to its URL and name a model that server has pulled:

```bash
export OLLAMA_HOST=http://ollama.internal:11434
dhruv check --base origin/main --model qwen2.5-coder:7b
```

Things to know before you rely on it:

- Dhruv sends no credentials and has no setting for them. The endpoint must be reachable from the machine as it is; control access to it at the network level.
- The file paths and patches of the analyzed files go to that endpoint. The result's `model` field names the model that was asked.
- All analyzed patches go to the model in one request, and Dhruv does not set the model's context window. Coverage states what Dhruv sent. If the patches are larger than the model's context window, the server may shorten the prompt, so serve a model with a window that fits `maxTotalBytes`, or lower that limit.
- The default model is small. If a run fails with `invalid-response`, the model did not return the requested JSON; choose a more capable one.
- One request has to finish within the timeout. Raise `--timeout` for large changes or slow hardware.
- No AI request is made when the range has nothing to analyze, so such a run succeeds even if Ollama is unreachable.

## Run it in GitHub Actions

Copy this workflow to `.github/workflows/dhruv-check.yml` in your repository. It needs a self-hosted runner that can reach your Ollama service, and two repository variables: `OLLAMA_HOST` (the service URL) and `DHRUV_CHECK_MODEL` (a model that service has pulled).

```yaml
name: Dhruv check

on:
  pull_request:

permissions:
  contents: read

jobs:
  check:
    # A runner you operate, on a network that can reach your Ollama service.
    runs-on: [self-hosted, linux, ollama]
    timeout-minutes: 20
    env:
      OLLAMA_HOST: ${{ vars.OLLAMA_HOST }}
      DHRUV_CHECK_MODEL: ${{ vars.DHRUV_CHECK_MODEL }}
      BASE_REF: ${{ github.base_ref }}
    steps:
      - name: Check out the pull request with its history
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install Dhruv
        working-directory: ${{ runner.temp }}
        run: npm install --global @rahul05ranjan/dhruv-cli

      - name: Review the committed changes
        run: |
          dhruv check --base "origin/$BASE_REF" \
            --model "$DHRUV_CHECK_MODEL" --timeout 600000 \
            --strict-coverage --json > "$RUNNER_TEMP/dhruv-check.json"

      - name: Keep the JSON result
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: dhruv-check
          path: ${{ runner.temp }}/dhruv-check.json
          if-no-files-found: error

      - name: Remove the log files Dhruv wrote
        if: always()
        run: |
          rm -f logs/dhruv-*.log logs/.*-audit.json
          rmdir logs 2>/dev/null || true
```

What each part is for:

| Part | Why |
| --- | --- |
| `runs-on: [self-hosted, linux, ollama]` | The job must run where your Ollama service is reachable. `ollama` is a label you give that runner; use your own. |
| `ref: ${{ github.event.pull_request.head.sha }}` | Reviews the pull request's own head commit, the same commit a developer reviews locally, instead of the temporary merge commit GitHub checks out by default. |
| `fetch-depth: 0` | Fetches full history and the remote branches. A shallow checkout has no merge base, and `check` fails with `no-merge-base` or `unknown-ref` instead of reviewing nothing. |
| `persist-credentials: false` | Leaves no token in the checkout's Git configuration. |
| `BASE_REF` in `env` | Passes the base branch name to the shell as data instead of pasting it into the script. |
| `npm install --global`, run in `runner.temp` | Installs Dhruv from npm, from a directory outside the checkout. The workflow never runs `npm ci`, a build, or any other script from the repository under review. Pin a version (`@<version>`) once you have chosen one; `check` is not in 1.12.0 or earlier. |
| `--model`, `--timeout`, `--json` as flags | Flags win over `.dhruv-config.json`, which is read from the checkout. See [Reviewing pull requests you do not trust](#reviewing-pull-requests-you-do-not-trust). |
| `--strict-coverage` | Fails the job with exit code 2 when relevant source was skipped or truncated, so a partial review cannot pass as a full one. Drop it if you only want the report. |
| `> "$RUNNER_TEMP/dhruv-check.json"` | Keeps the result out of the job log and out of the checkout. Nothing in the workflow prints it. |
| Upload with `if: always()` | Keeps the result when the review step fails; a failed run still writes a JSON object with `status` and `error`. |
| Last step | `check` writes log files into `logs/` in the directory it runs from. They hold startup diagnostics only, but a self-hosted workspace outlives the job. |

The job passes when the review completed with full coverage, whatever it found. To act on findings, read the artifact.

### What reaches the job log

- stdout carries the result and is redirected to the file. In JSON mode it holds exactly one object and no banner, patch, or model response.
- stderr reaches the log. It carries Dhruv's startup log lines, configuration warnings and, in text mode, error messages. It never carries a patch, a prompt, or a model response. An unusable model response is reported by kind only.
- The artifact holds file paths and the findings. A finding's `evidence` is model text and can quote the changed code. The artifact holds no patches. Anyone with read access to the repository can download it.

### Reviewing pull requests you do not trust

`check` treats the repository as data. It does not load Plugin Commands from `plugins/`, does not run repository scripts, parses the policy as JSON, and invokes Git without external diff or text-conversion drivers. Model responses are not cached on disk. That still leaves four things a pull request can influence:

| What the pull request controls | Effect | What to do |
| --- | --- | --- |
| `.dhruv-check.json` | The policy is read from the `HEAD` commit, so a pull request reviews itself under its own policy. It can exclude its own files, and files left out by the policy count as `ignored`, which keeps coverage complete and the exit code 0, even with `--strict-coverage`. It can also raise `minSeverity` to hide findings. | The result's `policy` object states the settings that were applied, and every left-out file is in `exclusions` with reason `ignored`. A pull request that edits or deletes the policy also has `.dhruv-check.json` in `exclusions`. Compare `policy` with the values you expect, require review for that file (for example with CODEOWNERS), or pass the settings as flags: a flag replaces its setting whatever the file says. |
| `.dhruv-config.json` | Read from the working directory, so from the checkout. It can change the model, the timeout, and the output format. | Pass `--model`, `--timeout`, and `--json` as flags, as the workflow does. Flags win. |
| The changed code itself | The patch is model input. The prompt tells the model to treat it as data, but text in a change can still steer a model away from reporting a problem. | Treat findings as advice for a human reviewer and never as approval. |
| The workflow file | On `pull_request`, GitHub runs the workflow as the pull request has it, so someone who can open a pull request can change these steps and run their own commands on your runner. Dhruv has no part in that. | Follow GitHub's guidance for self-hosted runners: keep them off public repositories, and require approval before workflows from outside contributors run. |

## Reference

### Options

| Option | Policy key | Default | Meaning |
| --- | --- | --- | --- |
| `--base <git-ref>` | | required | Branch, tag, or commit to compare with. The review covers the merge base of this ref and `HEAD`, up to `HEAD`. |
| `--include <globs...>` | `include` | `**` | Review only changed paths matching these globs. |
| `--exclude <globs...>` | `exclude` | none | Leave out changed paths matching these globs. |
| `--max-changed-files <count>` | `maxChangedFiles` | `50` | Consider at most this many changed files, in path order. |
| `--max-file-bytes <bytes>` | `maxFileBytes` | `65536` | Send at most this many bytes of one file's patch. |
| `--max-total-bytes <bytes>` | `maxTotalBytes` | `262144` | Send at most this many patch bytes in total. |
| `--min-severity <severity>` | `minSeverity` | `info` | Show findings of this severity or higher. |
| `--strict-coverage` | | off | Exit 2 when relevant changed source was skipped or truncated. |
| `--json` | | off | Write one JSON object to stdout instead of text. |
| `--model <model>` | | from configuration | Ollama model to ask. |
| `--timeout <milliseconds>` | | `45000` | Time allowed for the AI request. |

An option that has a policy key replaces that key for one run and leaves the file alone. `--include` and `--exclude` replace the whole list. `--json`, `--model`, and `--timeout` are global options and work before or after `check`.

### Policy file

The policy is `.dhruv-check.json` at the repository root. It is optional; without it the defaults below apply.

```json
{
  "schemaVersion": 1,
  "include": ["src/**", "packages/*/src/**"],
  "exclude": ["*.min.js", "src/generated", "vendor/"],
  "maxChangedFiles": 100,
  "maxFileBytes": 65536,
  "maxTotalBytes": 262144,
  "minSeverity": "low"
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | number | required | Must be `1`. |
| `include` | list of globs | `["**"]` | A changed file is in scope when at least one include glob matches it and no exclude glob does. Needs at least one glob. |
| `exclude` | list of globs | `[]` | Changed files matching any of these are out of scope and reported as `ignored`. |
| `maxChangedFiles` | whole number, 1 to 10000 | `50` | Number of in-scope changed files considered, in path order. Deleted and unsupported files count. Source files past the limit are reported as `file-limit`. |
| `maxFileBytes` | whole number, 1 to 16777216 | `65536` | Bytes of one file's patch (its changed hunks with their context, not the file's size) sent to the model. A larger patch is cut at a hunk boundary and reported as `truncated`; when not even the first hunk fits, the file is `oversized`. |
| `maxTotalBytes` | whole number, 1 to 16777216 | `262144` | Patch bytes sent in total. A file that no longer fits is skipped as `total-limit`; a later, smaller file may still fit. |
| `minSeverity` | severity | `"info"` | Findings below this severity are counted in `summary.omitted.belowMinSeverity` and not shown. |

Rules that apply to the file:

- It is read from the `HEAD` commit, like the rest of the review. Commit a policy change before it takes effect; an uncommitted edit is not used.
- It must be a regular file, at most 65536 bytes, holding one JSON object. A symbolic link is refused.
- Unknown keys, wrong types, and out-of-range values are errors. An invalid policy fails the run with `invalid-policy` and exit code 1 before any AI request.

Globs match repository-relative paths with `/` as the separator, and are case-sensitive.

| Pattern | Matches |
| --- | --- |
| `*` | Any run of characters inside one path segment |
| `?` | One character inside a path segment |
| `**` as a whole segment | Any number of segments, including none |
| A pattern without `/`, such as `*.min.js` | That name at any depth |
| A pattern with `/`, such as `src/api/*.ts` | Paths from the repository root; a leading `/` does the same |
| A pattern that matches a directory, such as `vendor` | Everything below that directory |
| A trailing `/`, such as `vendor/` | Directories only |

Negation (`!`), braces, character classes, backslashes, and `..` segments are not supported. A list holds at most 256 patterns of at most 256 characters each.

### Coverage and exclusion reasons

Every changed file that was not analyzed in full is listed in `exclusions` with one reason. `coverage.complete` is `false` when relevant source went unreviewed. Without `--strict-coverage` that is reported and the run still exits 0; with it the status is `incomplete` and the exit code is 2.

| Reason | Coverage stays complete | Meaning |
| --- | --- | --- |
| `ignored` | yes | Out of scope under the include and exclude globs. |
| `deleted` | yes | The file was deleted. |
| `binary` | yes | A file with a supported extension whose content Git treats as binary. |
| `unsupported` | yes | Not one of the supported source file extensions. |
| `no-line-changes` | yes | The change adds or modifies no line: a pure rename, a mode change, or a change that only removes lines. |
| `unreadable` | no | Git could not produce the file's patch. |
| `oversized` | no | Not even the first changed hunk fits `maxFileBytes`. |
| `file-limit` | no | Past `maxChangedFiles`. |
| `total-limit` | no | Would push the total past `maxTotalBytes`. |
| `truncated` | no | Analyzed up to `maxFileBytes`; the remaining hunks were not. |

Complete coverage means nothing was dropped for size or readability. It does not mean every changed file was reviewed: the rows marked "yes" are never sent to the model.

### JSON result

With `--json`, stdout is one line holding one object, for success and for failure. Keys keep this order; a key that does not apply is left out.

```json
{
  "schemaVersion": 1,
  "command": "check",
  "status": "ok",
  "refs": {
    "base": { "ref": "origin/main", "commit": "3ea120d02fdd78503dff98c6e627c520b6d03de0" },
    "mergeBase": "3ea120d02fdd78503dff98c6e627c520b6d03de0",
    "head": "d42be07cca7202e9e71f87a3901bde4c5fb25fc3"
  },
  "model": "qwen2.5-coder:7b",
  "policy": {
    "file": ".dhruv-check.json",
    "schemaVersion": 1,
    "include": ["**"],
    "exclude": ["dist", "*.min.js"],
    "maxChangedFiles": 50,
    "maxFileBytes": 65536,
    "maxTotalBytes": 262144,
    "minSeverity": "low",
    "overrides": []
  },
  "summary": {
    "findings": 1,
    "bySeverity": { "critical": 0, "high": 1, "medium": 0, "low": 0, "info": 0 },
    "candidates": 2,
    "omitted": { "invalid": 0, "offDiff": 1, "duplicate": 0, "belowMinSeverity": 0 }
  },
  "findings": [
    {
      "path": "src/payments/refund.ts",
      "line": 2,
      "severity": "high",
      "reason": "Audit entry is written before the refund succeeds",
      "evidence": "audit(reason) runs before gateway.refund(amount), so a failed refund still leaves an audit record",
      "recommendation": "Write the audit entry after the gateway call succeeds, or record the failure as well"
    }
  ],
  "coverage": {
    "changedFiles": 3,
    "analyzedFiles": 1,
    "skippedFiles": 2,
    "truncatedFiles": 0,
    "complete": true,
    "byReason": {
      "ignored": 1,
      "deleted": 0,
      "binary": 0,
      "unsupported": 1,
      "no-line-changes": 0,
      "unreadable": 0,
      "oversized": 0,
      "file-limit": 0,
      "total-limit": 0,
      "truncated": 0
    }
  },
  "exclusions": [
    { "path": "README.md", "reason": "unsupported" },
    { "path": "dist/bundle.js", "reason": "ignored" }
  ]
}
```

| Key | Present | Meaning |
| --- | --- | --- |
| `schemaVersion` | always | `1`. New keys may be added without changing it. |
| `command` | always | `"check"`. |
| `status` | always | `ok`, `incomplete`, `error`, or `cancelled`. See [Exit codes](#exit-codes). |
| `refs` | once the range was read | `base.ref` as you typed it, and the full commit IDs of the base, the merge base, and `HEAD`. |
| `model` | once the range was read | The model the run was configured to ask. |
| `policy` | once the range was read | The settings applied, after flags. `file` is `.dhruv-check.json` or `null` when the defaults applied; `overrides` lists the keys replaced by flags. |
| `summary` | `ok`, `incomplete` | Counts, described below. |
| `findings` | `ok`, `incomplete` | The reported findings, ordered by path, line, then severity. |
| `coverage` | once the range was read | Counts, described below. |
| `exclusions` | once the range was read | `{ path, reason }` for every file skipped or truncated, in path order. |
| `error` | `error`, `cancelled` | `kind`, `message`, and sometimes `hint`. |

"Once the range was read" covers every `ok` and `incomplete` result and the failures that happen after it, such as an unreachable model. Earlier failures, such as an unknown ref or an invalid policy, carry only `schemaVersion`, `command`, `status`, and `error`.

A command line that cannot be parsed, such as an unknown option, exits 1 with a usage message on stderr and no JSON object. Treat an empty stdout as a failure.

**`findings[]`**

| Field | Meaning |
| --- | --- |
| `path` | Repository-relative path of an analyzed file, with `/` separators. |
| `line` | A line in the new version of the file that the range added or modified. |
| `severity` | One of the [severities](#severities). |
| `reason` | One-line summary of the problem, at most 200 characters. |
| `evidence` | What in the change supports it, at most 500 characters. |
| `recommendation` | What to do about it, at most 500 characters. |

**`summary`**

| Field | Meaning |
| --- | --- |
| `findings` | Number of findings reported. |
| `bySeverity` | Reported findings per severity. |
| `candidates` | Findings the model proposed; equals `findings` plus everything under `omitted`. |
| `omitted.invalid` | Candidates that were malformed, incomplete, or carried an unknown severity. |
| `omitted.offDiff` | Candidates not on a changed line of an analyzed file. |
| `omitted.duplicate` | Repeats of a reported finding: same path, line, and reason. The most severe one is kept. |
| `omitted.belowMinSeverity` | Valid findings below `minSeverity`. |

**`coverage`**

| Field | Meaning |
| --- | --- |
| `changedFiles` | Files changed in the range, in scope or not. |
| `analyzedFiles` | Files sent to the model, truncated ones included. |
| `skippedFiles` | Files not sent at all. |
| `truncatedFiles` | Analyzed files whose patch was cut short. |
| `complete` | `false` when relevant source was skipped or truncated. |
| `byReason` | Number of exclusions per [reason](#coverage-and-exclusion-reasons). |

### Severities

| Severity | Meaning |
| --- | --- |
| `critical` | Exploitable flaw, data loss, or corruption. |
| `high` | Likely bug or security weakness. |
| `medium` | Correctness or maintainability risk. |
| `low` | Minor issue. |
| `info` | Observation that needs no action. |

The model assigns the severity. Dhruv checks that it is one of these five and nothing more.

### What validation guarantees

A reported finding names an analyzed file, sits on a line the range changed, carries a known severity, and has a reason, evidence, and a recommendation as single lines of printable text. Candidates that fail any of that are dropped and counted. If the response as a whole is not a JSON object with a `findings` list, the run fails with `invalid-response`.

Validation does not check that a finding is true, that its severity is deserved, or that the model noticed every problem. Zero findings means the model reported none.

### Exit codes

| Exit code | `status` | When |
| --- | --- | --- |
| `0` | `ok` | The review ran to the end: with findings, without findings, or on a range with no changes. Also when coverage is incomplete and `--strict-coverage` is not set. |
| `1` | `error` | Invalid input, option, or policy; Git unavailable or unable to establish the range; AI unreachable, timed out, or returned an unusable response. |
| `2` | `incomplete` | Coverage is incomplete and `--strict-coverage` is set. The result still carries the findings for what was analyzed. |
| `130` | `cancelled` | Interrupted with Ctrl-C while waiting for the model. An interrupt at any other moment ends the process without a result. |

In text mode a successful result goes to stdout and an error to stderr. An `incomplete` result writes its report to stdout and the reason to stderr.

### Error kinds

| `error.kind` | Meaning |
| --- | --- |
| `invalid-input` | `--base` is missing, or an option value is not valid. |
| `invalid-ref` | The base ref is empty or starts with `-`. |
| `unknown-ref` | The base ref does not name a commit in this repository. Fetch it. |
| `no-merge-base` | The base ref and `HEAD` share no history, as in a shallow checkout. |
| `not-a-repository` | The working directory is not inside a Git repository. |
| `git-unavailable` | Git is not installed or not on `PATH`. |
| `git-error` | Git failed while resolving or listing the range. |
| `invalid-policy` | `.dhruv-check.json` could not be read or failed validation. |
| `validation` | The request was refused by Dhruv's input validation. |
| `ai-connection` | The Ollama endpoint could not be reached. Check `OLLAMA_HOST`. |
| `ai-model-not-found` | The endpoint does not have the model. |
| `ai-empty-response` | The model returned nothing. |
| `ai-timeout` | The request did not finish within the timeout. |
| `ai-request` | The request failed for another reason. |
| `ai-cancelled` | Interrupted with Ctrl-C; the status is `cancelled`. |
| `invalid-response` | The model's response was not the requested JSON. |
| `internal` | An unexpected failure inside `check`. |

### Files `check` writes

`check` writes nothing into the repository except a `logs/` directory in the directory you run it from, holding `dhruv-<date>.log`, `dhruv-error-<date>.log`, and their rotation records. They contain startup diagnostics and no source, patch, prompt, or model response. Add `logs/` to `.gitignore`, or delete it after the run as the workflow above does.
