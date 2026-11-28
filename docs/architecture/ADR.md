# Architecture Decision Records (ADRs)

## ADR-001: Zero-Build Native ESM Frontend + `modulepreload` Invariant
- **Context**: ValuePort serves static assets directly via Cloudflare Workers `ASSETS` (`public/`) with no bundler. Every `<script type="module">` dependency chain incurs round-trips unless listed in `<link rel="modulepreload">`.
- **Decision**: Retain the zero-build native ESM architecture. Whenever inline `<script>` code is extracted from HTML pages or new shared frontend modules are introduced, update `<link rel="modulepreload">` in the affected HTML files and verify via `test-core/modulepreload.test.js`.
- **Consequences**: Fast deploys, zero build tooling complexity, explicit and machine-checked module dependency graphs.

## ADR-002: Pure Shared Domain Modules Under `public/shared/`
- **Context**: Both the browser and Cloudflare Worker execute identical valuation math, facts extraction, thesis/review normalization, macro percentile calculation, and feedback validation.
- **Decision**: Keep shared isomorphic pure-logic modules under `public/shared/` (zero DOM / browser-only APIs). Enforce directionality via automated tests: `public/shared/` may never import from `src/`, and any file imported by `src/` from `public/shared/` must remain DOM-free.
- **Consequences**: Single Source of Truth for domain rules across client and server without duplicating code or introducing a build step.

## ADR-003: Deletion Test for Every Abstraction
- **Context**: Over-fragmentation creates shallow forwarding layers that add indirection without encapsulating complexity.
- **Decision**: Every extracted module must own a clear domain boundary or eliminate real multi-file duplication. Retain public subsystem entry points (e.g., `src/ai.js`) only when they compose submodules and expose a stable public contract.
- **Consequences**: Deep, cohesive modules with clean ownership suitable for parallel agent development.

## ADR-004: Automated Enforceable Architecture via Vitest (`test-core/architecture.test.js`)
- **Context**: Refactoring alone decays over time unless invariants are enforced in CI.
- **Decision**: Encode structural invariants (acyclic imports, layer boundaries, canonical helper ownership, dead-file prevention, `navboot.js` storage-key parity, HTML inline-script budgets) as fast Node tests in `test-core/architecture.test.js`, executed automatically on every `npm test` and GitHub Actions CI run.
- **Consequences**: Regressions fail CI immediately without adding heavy external lint dependencies.
