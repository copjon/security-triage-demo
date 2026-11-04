# Multi-tenant engineering standard

## Tenant-scoped data access
All database reads and writes go through TenantScopedRepository. The tenant_id comes from the authenticated session, never from URL or request parameters. Authorization checks happen before any lookup, including cache lookups.

## Caching
Cache keys must start with t:{tenantId}:. Values that contain PHI must use the phi-cache Redis cluster (TLS, encryption at rest, no persistence to disk), never the shared-redis cluster. Maximum TTL for PHI is 15 minutes. Review SEC-063 rejected a cache that lacked the tenant prefix.

## Identifiers
Identifiers exposed in URLs, APIs or cache keys must be UUIDv7 or another opaque format. Auto-increment integer IDs must never be exposed, because they can be enumerated across tenants.

## Cross-tenant data use
Combining data from multiple tenants (analytics, reporting, ML training) needs GRC approval and a contract check. Our standard healthcare BAA (v3) prohibits secondary use of PHI, including model training, without the tenant's written authorization.

## Customer-managed keys and residency
Enterprise tier supports customer-managed keys through a per-tenant AWS KMS key the customer controls, and data residency in us-east-1 and us-east-2. Tenants can export their own audit logs through the tenant audit API. Contract commitments on keys or residency need CloudSec and Legal sign-off; we do not commit to key-revocation SLAs shorter than 1 hour.
