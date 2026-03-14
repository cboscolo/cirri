# Import Farcaster Casts to AT Protocol

## Status: TODO (blocked)

## Goal

Import a user's Farcaster casts into their AT Protocol repository as `app.bsky.feed.post` records, bridging their Farcaster content into the ATmosphere.

## Blocked On

- Designing a sync strategy: one-time import vs. continuous sync
- Deciding how to handle cast edits/deletes after initial import
- Mapping Farcaster-specific features (frames, channels, embeds) to AT Protocol equivalents

## Hub API

Casts can be fetched via the Hub/Snapchain API:

```
GET /v1/castsByFid?fid={fid}&pageSize=100&reverse=true
```

See `plans/reference/farcaster-hub-api.md` for full API documentation.

## Open Questions

1. **Record keys**: Use TID (new) or derive from Farcaster cast hash?
2. **Timestamps**: Use original Farcaster timestamp or import time?
3. **Replies/threads**: Import reply trees or only top-level casts?
4. **Mentions**: Map Farcaster FID mentions to AT Protocol DIDs?
5. **Embeds**: How to handle Farcaster frames, channel mentions, etc.?
6. **Rate limiting**: Hub APIs may rate-limit bulk fetches
