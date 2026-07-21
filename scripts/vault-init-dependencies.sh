#!/bin/sh
if ! command -v bash >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  apk update
fi
if ! command -v bash >/dev/null 2>&1; then
  apk add bash
fi
if ! command -v jq >/dev/null 2>&1; then
  apk add jq
fi
if ! command -v psql >/dev/null 2>&1; then
  apk add postgresql-client
fi

/opt/vault/init.sh