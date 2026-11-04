# HIPAA and PHI handling policy

## PHI outside production
PHI may not be copied to non-production environments, developer machines, contractor accounts or ML training buckets. Use the synthetic data generator for testing.

## Messaging patients
Patient-facing SMS and email may include only the patient's first name, clinic name, appointment date and time, and a link to the authenticated patient portal. Appointment type, provider specialty and diagnoses are prohibited under the minimum necessary standard, because they can reveal sensitive conditions. Only vendors with a signed BAA may send these messages.

## De-identification
De-identified data must meet Safe Harbor (removal of all 18 identifiers) or an Expert Determination. Free-text clinical notes always require Expert Determination; removing names is not sufficient.

## Breach response
Report any suspected exposure of PHI to SecOps/IR within 1 hour. GRC runs the four-factor breach risk assessment. Our BAA requires notifying the affected tenant within 10 days of discovery, which is stricter than the HIPAA 60-day limit.

## Logging
No PHI or payment data in application logs. Logging full request or response bodies is prohibited on any service that handles PHI or payment data; use structured logging with a field allowlist.
