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
The conversion of a requested file path, directory, or working-tree diff into validated source facts for an AI-assisted command.
_Avoid_: File loading, crawling

**Command Presentation**:
The user-visible rendering and process outcome chosen for a command's facts, including text and JSON forms.
_Avoid_: Output handling, formatting

**Runtime Diagnostic**:
A fact about Dhruv CLI readiness, including the configured model, local model availability, and host conditions.
_Avoid_: Health data, status data
