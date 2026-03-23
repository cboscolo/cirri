# Wire Up Cast Sync in sync-do.ts

## Overview

The sync service can build and submit CastAdd messages to the Hub (verified e2e on mainnet), but `syncRecord()` in `sync-do.ts` only handles `app.bsky.actor.profile`. This task wires up `app.bsky.feed.post` → CastAdd.

## What's Ready

- `buildCastMessage(fid, text, signerKey, options?)` in `farcaster-message.ts` — builds and signs CastAdd
- `submitMessage(hubUrl, messageBytes, hash)` in `hub-client.ts` — submits to Hub
- `syncRecord()` routing in `sync-do.ts` — has the create/delete dispatch, just needs a `syncPost()` method

## Implementation

1. Add `syncPost()` method to `SyncDurableObject` (similar to existing `syncProfile()`)
2. Extract `text` from `app.bsky.feed.post` record
3. Handle reply threading: if `record.reply?.parent?.uri` exists, extract parent FID + hash
4. Call `buildCastMessage()` and `submitMessage()`
5. Store rkey → farcaster_hash in `sync_mapping` table (for future delete support)
6. Add the collection routing in `syncRecord()`: `app.bsky.feed.post` → `syncPost()`

## Considerations

- **Text length:** Farcaster casts max 1024 bytes, ATProto posts max 300 graphemes (~1200 bytes). May need truncation.
- **Reply parent mapping:** Only works if the parent post was also synced (has a mapping entry) or the parent is a fid.is user (deterministic FID from DID).
- **Embeds:** ATProto posts can embed images (blob refs) and links. Image handling TBD.
- **Delete support:** Needs CastRemove message type (MESSAGE_TYPE_CAST_REMOVE = 2) — not yet implemented.

## Related

- `plans/in-progress/agent-profile-sync.md` — Current sync work
- `plans/todo/farcaster-sync-service.md` — Full sync service spec
- `plans/reference/fc-test-cli.md` — CLI tool for manual testing
