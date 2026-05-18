# Cedar-wasm Lambda layer source

This directory is consumed by
[`cdk/src/constructs/cedar-wasm-layer.ts`](../../src/constructs/cedar-wasm-layer.ts)
to build a Lambda layer that carries `@cedar-policy/cedar-wasm`.

## Why a separate directory

The layer build is hermetic: it runs `npm install --omit=dev` from
`package.json` in this directory, independent of
`cdk/node_modules/`. Keeping a dedicated `package.json` here means a
stale top-level install cannot leak into the layer bundle.

## Keeping the version in sync

The pinned version here **must match** the `@cedar-policy/cedar-wasm`
entry in `cdk/package.json`. Drift would let the Lambda-side wasm
engine and the rest of the CDK package disagree — the parity contract
(§15.6, decision #23) catches this in CI only for the wasm-vs-cedarpy
direction, not for two wasm copies in the same stack.

Update process when bumping cedar-wasm:

1. Bump `cdk/package.json` in the repo root install.
2. Bump `cdk/layers/cedar-wasm/package.json` to the same version.
3. Bump `CEDAR_WASM_VERSION` in `cdk/src/constructs/cedar-wasm-layer.ts`.
4. Run `contracts/cedar-parity/` tests on both sides; they fail if the
   wasm vs cedarpy engine outputs diverge.

## Layout produced

```
/opt/nodejs/node_modules/@cedar-policy/cedar-wasm/
  nodejs/cedar_wasm.js
  nodejs/cedar_wasm_bg.wasm
  ...
```

Lambdas using the layer `require('@cedar-policy/cedar-wasm/nodejs')`.
