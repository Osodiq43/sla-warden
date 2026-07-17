FROM node:22-slim

# Install curl, git, and sqlite
RUN apt-get update && apt-get install -y \
    curl \
    git \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Install the official onchainos CLI binary
RUN curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh

# Ensure the binary path is globally accessible
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Explicitly copy configuration files individually
COPY package.json ./
COPY package-lock.json ./
COPY tsconfig.json ./

# Run clean install
RUN npm ci

# Copy application source code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Render injects its own PORT variable, expose it
EXPOSE 10000

# Start the A2MCP Express server directly
CMD ["npm", "start"]