FROM node:20-slim AS deps

WORKDIR /deps

RUN apt-get update && apt-get install -y git python3 make g++ curl && rm -rf /var/lib/apt/lists/*

# Install Rust (needed to build chronicle's native bindings)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Clone and build mcpl-core-ts
RUN git clone --depth 1 https://github.com/anima-research/mcpl-core-ts.git mcpl-core-ts \
 && cd mcpl-core-ts && npm install && npx tsc

# Clone and build chronicle (native N-API bindings from Rust)
RUN git clone --depth 1 https://github.com/anima-research/chronicle.git chronicle \
 && cd chronicle && npm install && npm run build

# ---

FROM node:20-slim

WORKDIR /app

COPY --from=deps /deps/mcpl-core-ts /deps/mcpl-core-ts
COPY --from=deps /deps/chronicle /deps/chronicle

COPY package.json package-lock.json ./
RUN sed -i 's|file:../mcpl-core-ts|file:/deps/mcpl-core-ts|' package.json \
 && sed -i 's|file:../chronicle|file:/deps/chronicle|' package.json \
 && npm install

COPY src/ src/
COPY tsconfig.json ./

COPY ui/ ui/
RUN cd ui && npm install && npm run build

EXPOSE 3100

CMD ["npm", "start"]
