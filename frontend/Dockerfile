ARG BASE_IMAGE=docker.io/nginxinc/nginx-unprivileged:stable-alpine
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.version="1.0.0"

COPY --chown=101:101 nginx.conf /etc/nginx/conf.d/default.conf

COPY --chown=101:101 \
    index.html \
    styles.css \
    actions.js \
    details.js \
    app.js \
    /usr/share/nginx/html/

USER 101:101

EXPOSE 8080 8443
