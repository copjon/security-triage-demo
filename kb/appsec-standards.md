# Application security standards

## Web application baseline
Session cookies must be HttpOnly, Secure and SameSite=Lax. Use framework auto-escaping for output and enforce a Content Security Policy. Remediation SLAs: high-severity findings within 7 days; findings that allow session theft or cross-tenant access within 72 hours.

## Public and partner APIs
API keys go in the Authorization header, never in the query string, because query strings are written to proxy and access logs. Rate limiting is required before launch. Partner APIs use per-partner scoped keys and object-level authorization on every request.

## Webhooks
Inbound webhooks must verify an HMAC signature, reject requests whose timestamp is more than 5 minutes old to prevent replay, and only trigger actions for allowlisted sources.

## Password storage
Use argon2id (64 MB memory, 3 iterations, parallelism 1). Rehashing on next successful login is the approved migration path; force a reset for accounts inactive for more than a year.

## Container base images
Approved base images include node:22-bookworm-slim and the distroless images. Upgrading to an approved base image through the standard CI pipeline is a pre-approved change and needs no security review.
