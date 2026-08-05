# falstad-cirquit task runner. `just` with no arguments lists everything.

set shell := ["bash", "-uc"]

wasm_out := "web/src/wasm"
upstream := "https://github.com/pfalstad/circuitjs1.git"

_default:
    @just --list --unsorted

# One-time developer setup: rust target, wasm-pack, node deps, upstream reference.
setup: reference
    rustup target add wasm32-unknown-unknown
    command -v wasm-pack >/dev/null || cargo install wasm-pack
    cd web && npm ci || (cd web && npm install)

# Clone the upstream project into ./reference (gitignored) for format lookups.
reference:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -d reference/circuitjs1/.git ]; then
      echo "reference/circuitjs1 already present"
    else
      mkdir -p reference
      git clone --depth 1 {{ upstream }} reference/circuitjs1
    fi

# Compile the Rust engine to WebAssembly (release).
wasm:
    wasm-pack build engine/wasm --release --target web --out-dir ../../{{ wasm_out }} --out-name circuit_engine

# Same, but with debug assertions and readable panics.
wasm-dev:
    wasm-pack build engine/wasm --dev --target web --out-dir ../../{{ wasm_out }} --out-name circuit_engine

# Run the Vite dev server (run `just wasm` yourself after an engine change).
dev:
    cd web && npm run dev

# Production build of the static site into web/dist.
build: wasm
    cd web && npm run build

# Serve the production build locally.
preview: build
    cd web && npm run preview

# Rust unit tests (native, fast).
test-rust:
    cd engine && cargo test --workspace

# TypeScript unit tests.
test-web:
    cd web && npm run test -- --run

test: test-rust test-web

# Formatting and linting, matching CI.
lint:
    cd engine && cargo fmt --all -- --check
    cd engine && cargo clippy --workspace --all-targets -- -D warnings
    cd web && npm run lint
    cd web && npm run typecheck

format:
    cd engine && cargo fmt --all
    cd web && npm run format

# Everything CI runs, in CI order.
ci: lint test build

# Copy the upstream example-circuit library into the static site.
import-cirquits-upstream: reference
    #!/usr/bin/env bash
    set -euo pipefail
    src=reference/circuitjs1/src/com/lushprojects/circuitjs1/public
    mkdir -p web/public/circuits
    cp "$src"/circuits/*.txt web/public/circuits/
    cp "$src"/setuplist.txt web/public/circuits/
    echo "imported $(ls web/public/circuits | wc -l) files"

clean:
    rm -rf engine/target {{ wasm_out }} web/dist web/node_modules
