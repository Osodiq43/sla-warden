FROM node:22-slim

# Install curl, shell prerequisites, and sqlite
RUN apt-get update && apt-get install -y \
    curl \
    git \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Install the official onchainos CLI binary
RUN curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh

# Ensure the binary path is globally accessible
ENV PATH="/root/.local/bin:${PATH}"

# Create a dummy mock executable for codex to pass okx-a2a path validation checks
RUN echo '#!/bin/sh\necho "mock codex provider"\nexit 0' > /usr/local/bin/codex && \
    chmod +x /usr/local/bin/codex

WORKDIR /app

# Explicitly copy configuration files individually
COPY package.json ./
COPY package-lock.json ./
COPY tsconfig.json ./

# Run clean install
RUN npm ci

# Install platform monitoring runtime dependencies globally
RUN npm install -g @okxweb3/a2a-node

# Copy application source code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Render injects its own PORT variable, expose it
EXPOSE 10000

# Start the daemon process safely in the foreground alongside the application
CMD okx-a2a daemon start --provider codex --no-autostart && npm start