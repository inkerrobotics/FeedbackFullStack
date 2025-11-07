# Multi-stage Dockerfile for Render Free Tier Deployment
# Optimized for 512MB RAM limit with aggressive memory management
# WhatsApp Feedback Collection System - Frontend (React+Vite) + Backend (Node.js+Express)
# ============================================
# Stage 1: Build Frontend (React + Vite + TypeScript)
# ============================================
FROM node:18-alpine AS frontend-builder

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++ && \
    rm -rf /var/cache/apk/*

# Set working directory for frontend
WORKDIR /app/frontend

# Copy frontend package files first (for better caching)
COPY frontend/package*.json ./

# Set build environment variables (NOT NODE_ENV=production yet, to install devDependencies)
ENV GENERATE_SOURCEMAP=false
ENV CI=false
ENV DISABLE_ESLINT_PLUGIN=true
ENV TSC_COMPILE_ON_ERROR=true

# API configuration for frontend build (will use same domain since combined)
ENV VITE_API_BASE_URL="/api"

# Install dependencies with optimizations
# --legacy-peer-deps: Handle peer dependency conflicts
# --no-audit: Skip security audit (faster)
# --no-fund: Skip funding messages
# --prefer-offline: Use cache when possible
# NOTE: NOT using --only=production because we need devDependencies (TypeScript, Vite, etc.) for build
RUN npm cache clean --force && \
    npm ci --legacy-peer-deps --no-audit --no-fund --prefer-offline

# Copy frontend source code
COPY frontend/ ./

# Build React app with Vite (TypeScript compilation + bundling)
RUN npm run build

# Verify build output exists
RUN ls -la dist/ && \
    test -f dist/index.html || (echo "Build failed: index.html not found" && exit 1)

# Clean up to free memory
RUN npm cache clean --force && \
    rm -rf node_modules/.cache && \
    rm -rf /tmp/* && \
    rm -rf ~/.npm

# ============================================
# Stage 2: Setup Backend + Serve Frontend
# ============================================
FROM node:18-alpine AS production

# Set working directory
WORKDIR /app

# Install system dependencies (minimal for free tier)
# curl: for health checks
# openssl: required by Prisma
RUN apk add --no-cache curl openssl && \
    rm -rf /var/cache/apk/*

# Copy backend package files
COPY Backend/package*.json ./

# Install backend dependencies (production only)
RUN npm ci --only=production --legacy-peer-deps --no-audit --no-fund && \
    npm cache clean --force

# Copy backend source code
COPY Backend/ ./

# Copy Prisma schema and generate client
RUN npx prisma generate && \
    echo "✅ Prisma client generated successfully"

# Create public directory for serving frontend
RUN mkdir -p ./public

# Copy built frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist ./public

# Verify frontend files copied correctly
RUN ls -la ./public/ && \
    test -f ./public/index.html || (echo "Frontend build not found" && exit 1)

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Set environment variables for production
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# WhatsApp Business API Configuration (defaults)
ENV WHATSAPP_API_VERSION=v22.0

# Expose the port
EXPOSE 8080

# Health check (optimized for free tier)
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=2 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start the application
CMD ["node", "server.js"]