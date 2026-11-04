# Build-only protocol source

Unmodified `src/`, `package.json` and root MIT `LICENSE` from
https://github.com/deepseek-ai/deepseek-harness at
`f3803c96974ad4a94195fb97e5c637e9c2a3afe3` (tag `dsh-v0.2.2-alpha.2`,
`packages/typert/protocol`). The previously recorded reference
`ce7073d51254c26cd63b22a60835b8f948deb447` has byte-identical protocol `src/`;
this provenance correction changes no source or generated artifacts. See
`docs/client-runtime/upstream-provenance.md` for publication reconstruction evidence.

The upstream generator recognizes Remote symbols by workspace package identity,
not an installed npm declaration's package identity. This source-only compiler
input gives it that identity. Runtime uses the pinned npm 0.2.2-alpha.2 package;
this directory is NOT an npm workspace and does not introduce a second runtime.
Only the local tsconfig and this notice are added. No upstream source patches.
