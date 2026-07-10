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

# Copy configuration and package files
COPY package*.json tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy application source code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Render injects its own PORT variable, expose it
EXPOSE 10000

# Start the application
CMD ["npm", "start"]
