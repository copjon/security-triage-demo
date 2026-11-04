# Data classification standard

## Classification levels
Restricted: PHI, government ID images, payment card data, credentials and secrets. Confidential: customer PII such as names and emails, and customer business data. Internal: employee-only information. Public: approved for release.

## Restricted data storage
Restricted data must be stored with SSE-KMS using a service-specific key, S3 Block Public Access enabled, and access logging on. Presigned URLs for Restricted objects expire within 15 minutes. Government ID images are deleted 30 days after verification completes.

## Sharing outside the company
Restricted and Confidential data may leave our AWS organization only to processors with a signed DPA, plus a BAA if PHI is involved. Production database snapshots may never be shared with accounts outside our AWS organization; contractors work inside our VDI environment instead.
