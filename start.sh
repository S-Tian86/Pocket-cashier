#!/bin/sh
# Inicia la caja. Uso: ./start.sh [--port 8080]
cd "$(dirname "$0")" || exit 1
exec node server.js "$@"
