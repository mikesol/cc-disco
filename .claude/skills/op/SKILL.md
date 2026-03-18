---
name: op
description: Access secrets from 1Password using the op CLI
---

# 1Password (op)

Secrets are stored in 1Password and accessed via the `op` CLI.

## Prerequisites
- `op` CLI installed
- `OP_SERVICE_ACCOUNT_TOKEN` set in the environment (usually via `/etc/environment` or systemd `EnvironmentFile`)

## Reading a secret
op read "op://vault-name/item-name/field-name"

## Examples
op read "op://openclaw/Discord Bot Token/password"
op read "op://openclaw/Brave Search API Key/password"
op read "op://openclaw/Anthropic API Key/password"

## Listing vault contents
op item list --vault vault-name

## Creating a secret
op item create --category=password --title="Item Name" --vault=vault-name password='secret-value'

## In scripts
TOKEN=$(op read "op://openclaw/Discord Bot Token/password")
curl -H "Authorization: Bearer $TOKEN" ...
