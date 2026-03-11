# ─────────────────────────────────────────────
# Dockerfile – Lost Ark Discord Bot
# ─────────────────────────────────────────────

# Use the official Node 20 slim image for a small footprint
FROM node:20-slim

# Set working directory inside the container
WORKDIR /app

# Railway injects PORT but this bot doesn't need it; set NODE_ENV explicitly
ENV NODE_ENV=production

# Copy package files first so Docker can cache the npm install layer
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy the rest of the source code
COPY . .

# Ensure the data directory exists (persisted via volume in production)
RUN mkdir -p data

# The .env file should be mounted as a volume or provided via Docker secrets.
# Do NOT bake secrets into the image.

# Run the bot
CMD ["node", "bot.js"]
