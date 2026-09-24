# Security allowlist stays independent of Built-in Command definitions

Built-in Command definitions are the single source of truth for command-line, menu and completion facts (#123), but the `allowedCommands` list in `src/core/security.ts` deliberately stays a separate, hand-maintained list rather than being derived from them. It is enforced only in `runCommand`, the path that sends user input to the model, so it answers a different question — "may this command send input to the model?" — and deriving it would silently grant that to every new Built-in Command. Adding a command to the allowlist must remain an explicit decision.

## Consequences

- Adding a Built-in Command that goes through `runCommand` needs two edits: its definition and the allowlist. A missing allowlist entry fails closed (`Command '<name>' is not allowed`), which is the intended default.
- The list currently also names commands that never reach `runCommand` (`init`, `status`, `project-type`, `menu`, `completion`, `help`); those entries are inert, and trimming them is housekeeping, not a change to this decision.
- The Joi `generate` type list in the same file is input validation, not an access decision, so this ADR does not cover it; de-duplicating it with the `generate` definition is a separate follow-up.
