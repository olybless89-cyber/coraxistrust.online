FROM node:22.12.0-alpine AS builder

WORKDIR /app

# Public client config. Vite inlines VITE_* at build time, so these must be
# present during `vite build`, not just at runtime. Railway injects service
# variables as Docker build args when they are declared here.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_SENTRY_DSN
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_SENTRY_DSN=$VITE_SENTRY_DSN

# Copy package files
COPY package.json ./

# Install dependencies (ignore engine warnings, force fresh install)
RUN npm install --legacy-peer-deps --ignore-scripts

# Copy source
COPY . .

# Build
RUN node_modules/.bin/vite build

# Production stage - serve with nginx
FROM nginx:alpine AS runner

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx config for SPA routing (all routes serve index.html)
RUN printf 'server {\n\
  listen $PORT;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  location / {\n\
    try_files $uri $uri/ /index.html;\n\
  }\n\
}\n' > /etc/nginx/conf.d/default.conf.template

# Use envsubst to fill in $PORT at runtime
CMD ["/bin/sh", "-c", "envsubst '$PORT' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
