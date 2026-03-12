FROM node:20-slim AS deps

WORKDIR /deps

# Install git for cloning dependencies
RUN apt-get update && apt-get install -y git python3 make g++ && rm -rf /var/lib/apt/lists/*

# Clone and build mcpl-core-ts
RUN git clone --depth 1 https://github.com/anima-research/mcpl-core-ts.git mcpl-core-ts \
 && cd mcpl-core-ts && npm install && npx tsc

# Clone chronicle (pre-built native bindings)
RUN git clone --depth 1 https://github.com/anima-research/chronicle.git chronicle

# ---

FROM node:20-slim

WORKDIR /app

# Copy dependencies
COPY --from=deps /deps/mcpl-core-ts /deps/mcpl-core-ts
COPY --from=deps /deps/chronicle /deps/chronicle

# Copy package.json and rewrite file: paths
COPY package.json package-lock.json ./
RUN sed -i 's|file:../mcpl-core-ts|file:/deps/mcpl-core-ts|' package.json \
 && sed -i 's|file:../chronicle|file:/deps/chronicle|' package.json \
 && npm install

# Copy server source
COPY src/ src/
COPY tsconfig.json ./

# Build UI
COPY ui/ ui/
RUN cd ui && npm install && npm run build

EXPOSE 3100

CMD ["npm", "start"]
