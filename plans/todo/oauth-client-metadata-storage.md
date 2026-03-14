# OAuth Client Metadata Storage Fix

## Summary

The `SqliteOAuthStorage` class in `packages/pds/src/oauth-storage.ts` doesn't persist all `ClientMetadata` fields defined in `packages/oauth-provider/src/storage.ts`.

## Missing Fields

The `ClientMetadata` interface includes these fields that are not stored:

| Field | Type | Purpose |
|-------|------|---------|
| `tokenEndpointAuthMethod` | `"none" \| "private_key_jwt"` | Required for confidential client authentication |
| `jwks` | `{ keys: JWK[] }` | Client's public keys for `private_key_jwt` auth |
| `jwksUri` | `string` | URI to fetch client's JWKS |

## Impact

Confidential OAuth clients (using `private_key_jwt` authentication) won't have their auth method or keys cached. The client resolver would need to re-fetch metadata on every token request, causing:

1. Additional network requests to resolve client DID documents
2. Potential latency in token exchange
3. Wasted bandwidth

## Priority

**Low** - Only affects confidential clients, which WebFID may not use initially. Public clients (the common case for mobile/web apps) are unaffected.

## Fix

### 1. Add columns to `oauth_clients` table

In `SqliteOAuthStorage.initSchema()`:

```sql
ALTER TABLE oauth_clients ADD COLUMN token_endpoint_auth_method TEXT;
ALTER TABLE oauth_clients ADD COLUMN jwks TEXT;  -- JSON blob
ALTER TABLE oauth_clients ADD COLUMN jwks_uri TEXT;
```

For new installations, update the CREATE TABLE statement:

```sql
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    logo_uri TEXT,
    client_uri TEXT,
    token_endpoint_auth_method TEXT,
    jwks TEXT,
    jwks_uri TEXT,
    cached_at INTEGER NOT NULL
);
```

### 2. Update `saveClient()` method

```typescript
async saveClient(clientId: string, metadata: ClientMetadata): Promise<void> {
    this.sql.exec(
        `INSERT OR REPLACE INTO oauth_clients
        (client_id, client_name, redirect_uris, logo_uri, client_uri,
         token_endpoint_auth_method, jwks, jwks_uri, cached_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        clientId,
        metadata.clientName,
        JSON.stringify(metadata.redirectUris),
        metadata.logoUri ?? null,
        metadata.clientUri ?? null,
        metadata.tokenEndpointAuthMethod ?? null,
        metadata.jwks ? JSON.stringify(metadata.jwks) : null,
        metadata.jwksUri ?? null,
        metadata.cachedAt ?? Date.now(),
    );
}
```

### 3. Update `getClient()` method

```typescript
async getClient(clientId: string): Promise<ClientMetadata | null> {
    const rows = this.sql
        .exec(
            `SELECT client_id, client_name, redirect_uris, logo_uri, client_uri,
                    token_endpoint_auth_method, jwks, jwks_uri, cached_at
            FROM oauth_clients WHERE client_id = ?`,
            clientId,
        )
        .toArray();

    if (rows.length === 0) return null;

    const row = rows[0]!;
    return {
        clientId: row.client_id as string,
        clientName: row.client_name as string,
        redirectUris: JSON.parse(row.redirect_uris as string) as string[],
        logoUri: (row.logo_uri as string) ?? undefined,
        clientUri: (row.client_uri as string) ?? undefined,
        tokenEndpointAuthMethod: (row.token_endpoint_auth_method as "none" | "private_key_jwt") ?? undefined,
        jwks: row.jwks ? JSON.parse(row.jwks as string) : undefined,
        jwksUri: (row.jwks_uri as string) ?? undefined,
        cachedAt: row.cached_at as number,
    };
}
```

### 4. Update DO RPC bridge

The `DOProxyOAuthStorage` in `src/oauth.ts` and corresponding RPC methods in `src/account-do.ts` should already pass through the full `ClientMetadata` object, but verify they handle the new fields correctly.

## Files to Modify

- `packages/pds/src/oauth-storage.ts` - Schema and methods
- `packages/pds/src/oauth.ts` - Verify RPC proxy passes all fields
- `packages/pds/src/account-do.ts` - Verify RPC methods handle all fields

## Testing

1. Unit test: Save and retrieve a confidential client with JWKS
2. Integration test: OAuth flow with a confidential client
3. Migration test: Existing databases without new columns should upgrade gracefully

## Migration Strategy

Use SQLite's `ALTER TABLE ADD COLUMN` which allows adding nullable columns to existing tables without data migration. New columns will be NULL for existing rows, which is acceptable since they'll be re-fetched on next client resolution.
