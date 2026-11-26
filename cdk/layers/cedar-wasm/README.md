# Cedar-wasm Lambda layer source

[`cdk/src/constructs/cedar-wasm-layer.ts`](../../src/constructs/cedar-wasm-layer.ts)
builds a Lambda layer from this directory. The layer carries
`@cedar-policy/cedar-wasm`.

## Why a separate directory

The layer build is hermetic. It runs `npm install --omit=dev` from
`package.json` in this directory, independent of
`cdk/node_modules/`. With a dedicated `package.json` here, a
stale top-level install cannot get into the layer bundle.

## Keeping the version in sync

The pinned version here **must match** the `@cedar-policy/cedar-wasm`
entry in `cdk/package.json`. Drift would let the Lambda-side wasm
engine and the rest of the CDK package disagree. The parity contract
(§15.6, decision #23) catches drift in CI only between wasm and
cedarpy, not between two wasm copies in the same stack.

To bump cedar-wasm:

1. Bump `cdk/package.json` in the repo root install.
2. Bump `cdk/layers/cedar-wasm/package.json` to the same version.
3. Bump `CEDAR_WASM_VERSION` in `cdk/src/constructs/cedar-wasm-layer.ts`.
4. Run the `contracts/cedar-parity/` tests on both sides. They fail if the
   wasm and cedarpy engine outputs diverge.

## Layout produced

```
/opt/nodejs/node_modules/@cedar-policy/cedar-wasm/
  nodejs/cedar_wasm.js
  nodejs/cedar_wasm_bg.wasm
  ...
```

Lambdas that use the layer call `require('@cedar-policy/cedar-wasm/nodejs')`.
