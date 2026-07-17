FROM node:20-slim

# Install curl and shell prerequisites
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install the official onchainos CLI binary
RUN curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh

# Ensure the binary is globally accessible in the container path
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Explicitly copy configuration files individually
COPY package.json ./
COPY package-lock.json ./
COPY tsconfig.json ./

# Run clean install
RUN npm ci

# Install platform monitoring runtime dependencies and run diagnostic fix
RUN npm install -g @okxweb3/a2a-node
RUN npx okx-a2a doctor --fix

# Copy application source code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Render injects its own PORT variable, expose it
EXPOSE 10000

# Start the application directly without the shell setup hook
CMD ["npm", "start"]