# Stage 3 Anchor programs (spec 6.9)

- **`proposal-gate`** — Guarded-mode enforcement. COMPLETE and proven on the
  real governance binary in bankrun (Option A, D-033): it holds realm
  authority, welds the community front door, validates every proposal's
  instruction bytes against the menu, and ratchets mode one-way (INV-11).
  Built with `cargo-build-sbf`; the committed fixture is
  `tests/fixtures/proposal_gate.so.gz`.

  **Not yet deployed to mainnet** — that is the single remaining step to make
  Guarded selectable. Turnkey runbook + script:
  `proposal-gate/DEPLOY.md` and `scripts/deploy-gate.sh` (needs an
  operator-funded deployer + an upgrade-authority decision; the program is
  unaudited, so deploying is a deliberate operator override of the GATE 3
  audit precondition).

- **`launch-coordinator`** — atomic single-tx launch + programmatic fee
  custody. Not started (post-Guarded; spec 6.9 / GATE 3).

Toolchain + key-handling: DECISIONS.md D-029.
