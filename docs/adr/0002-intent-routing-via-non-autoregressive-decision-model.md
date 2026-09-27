# Intent Routing via non-autoregressive decision model

Dhruv CLI uses a non-autoregressive System 1 decision model (Laya) for Intent Routing rather than delegating command dispatch to the generative LLM (Ollama) or relying solely on manual subcommand invocation.

Generative autoregressive LLMs require 500ms–2000ms+ per query, generate variable text that must be parsed, and risk prompt injection or hallucinations during command selection. In contrast, non-autoregressive decision models evaluate fixed typed questions in a single forward pass (~33 ms), returning mathematically calibrated probabilities.

## Consequences

- Natural language queries passed directly to `dhruv "<query>"` are classified in sub-35ms to dispatch the corresponding Built-in Command (`explain`, `suggest`, `fix`, `review`, `optimize`, `security-check`).
- The decision model never generates text, eliminating parsing errors, prompt injection, and hallucinations at the routing layer.
- If the confidence score falls below the threshold (0.60), Dhruv CLI does not guess; it falls back to the interactive menu (`dhruv menu`) with the user's query pre-populated.
- The generative LLM (Ollama) remains solely responsible for generation and reasoning (System 2), keeping routing fast, light, and predictable.
