# Past review decisions

## SEC-042: KYC document upload bucket (Feb 2026)
Approved with conditions: SSE-KMS with a dedicated key, Block Public Access, presigned PUT URLs valid for 5 minutes, malware scanning on upload, 30-day retention, and a separate AWS account for the bucket.

## SEC-057: Debug body logging in billing service (Apr 2026)
Rejected. Approved alternative: structured logs with a field allowlist plus sampled payloads with card and PHI fields redacted, retained for 7 days.

## SEC-063: Shared Redis cache for scheduling widget (May 2026)
Rejected because the cache key lacked a tenant prefix and the value held PHI. Rebuilt on the phi-cache cluster with t:{tenantId}: keys and authorization before lookup.

## SEC-071: ML training on support tickets (Jul 2026)
Approved only after Expert Determination de-identification and per-tenant opt-in. Healthcare tenants are excluded unless they give written authorization under their BAA.
