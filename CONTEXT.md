# Dhruv CLI

Dhruv CLI is a local-first developer assistant that turns command-line requests and workspace sources into AI-assisted guidance. This glossary names the concepts shared by its command paths.

## Language

**Built-in Command**:
A Dhruv CLI command supplied by the application and available through command-line, interactive-menu, and completion paths.
_Avoid_: Native command, internal command

**Plugin Command**:
A command contributed at runtime by a plugin through the existing Commander adapter path.
_Avoid_: Extension command, external command

**Source Ingestion**:
The conversion of a requested file path, directory, working-tree diff, or Committed Range into validated source facts for an AI-assisted command.
_Avoid_: File loading, crawling

**Committed Range**:
The committed changes from the merge base of a base ref and `HEAD` up to `HEAD`, which is what `check` reviews.
_Avoid_: Branch diff, PR diff

**Check Policy**:
The checked-in settings, read from the reviewed commit, that fix which changed files a `check` run covers, how much of them it sends, and which Findings it shows.
_Avoid_: Check config, rules file

**Finding**:
A problem the model proposed that `check` reports because it sits on a changed line of an analyzed file; advisory, never verified as true.
_Avoid_: Issue, violation, error

**Coverage**:
The account of how much of the requested source a command examined: what it analyzed, what it skipped or truncated and why, and whether relevant source went unexamined.
_Avoid_: Test coverage, completeness

**Command Presentation**:
The user-visible rendering and process outcome chosen for a command's facts, including text and JSON forms.
_Avoid_: Output handling, formatting

**Runtime Diagnostic**:
A fact about Dhruv CLI readiness, including the configured model, local model availability, and host conditions.
_Avoid_: Health data, status data

**Intent Routing**:
The conversion of a free-form natural language query into a target Built-in Command dispatch using non-autoregressive decision classification.
_Avoid_: Query classification, command guessing, prompt routing
