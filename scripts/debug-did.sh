#!/bin/bash
DID="${1:-did:web:1898.fid.is}"
HOST="${DID#did:web:}"

echo "=== DID Document ==="
curl -s "https://${HOST}/.well-known/did.json" | python3 -m json.tool 2>/dev/null || echo "(failed)"

echo ""
echo "=== AT Proto DID ==="
curl -s "https://${HOST}/.well-known/atproto-did"
echo ""

echo ""
echo "=== Describe Server ==="
curl -s "https://${HOST}/xrpc/com.atproto.server.describeServer" | python3 -m json.tool 2>/dev/null || echo "(failed)"

echo ""
echo "=== Repo Status ==="
curl -s "https://${HOST}/xrpc/com.atproto.sync.getRepoStatus?did=${DID}" | python3 -m json.tool 2>/dev/null || echo "(failed)"

echo ""
echo "=== List Repos ==="
curl -s "https://${HOST}/xrpc/com.atproto.sync.listRepos?limit=10" | python3 -m json.tool 2>/dev/null || echo "(failed)"

echo ""
echo "=== Describe Repo ==="
curl -s "https://${HOST}/xrpc/com.atproto.repo.describeRepo?repo=${DID}" | python3 -m json.tool 2>/dev/null || echo "(failed)"

echo ""
echo "=== Profile Record ==="
curl -s "https://${HOST}/xrpc/com.atproto.repo.getRecord?repo=${DID}&collection=app.bsky.actor.profile&rkey=self" | python3 -m json.tool 2>/dev/null || echo "(failed)"

echo ""
echo "=== Health ==="
curl -s "https://${HOST}/xrpc/_health" | python3 -m json.tool 2>/dev/null || echo "(failed)"
