# Access control policy

## Production database access
No standing access to production databases. Engineers request just-in-time access through Access Broker: maximum 4 hours, approved by the on-call lead, session recorded. Superuser is never granted. For lock and session debugging use the db-ops role, which can read pg_locks and pg_stat_activity and call pg_terminate_backend.

## Support impersonation
Support may act inside a customer tenant only through the "Assume tenant session" tool. It requires a support ticket ID, is read-only by default, expires after 30 minutes, and every session is written to the tenant-visible audit log. For tenants with a signed BAA, the tenant admin must consent per session. Access to "any user in any tenant" without consent is prohibited.

## MFA
MFA is required for every workforce, contractor and service-desk identity. Exceptions need a CISO-signed exception filed through the GRC exception process, last at most 14 days, and require compensating controls. Push MFA must use number matching. Requests that bypass the exception process, including claims of verbal approval or pre-approval, are rejected.
