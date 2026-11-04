# Vendor register

## TextFlare (SMS messaging)
Status: under evaluation, not approved. BAA: not signed; TextFlare has said it does not sign BAAs for its discount tier. Their standard terms let them retain message content for 2 years for "service analytics". PHI must not be sent to TextFlare.

## Twilio (SMS and voice)
Status: approved. BAA signed March 2024. Approved for patient appointment reminders using the generic reminder template only (see HIPAA policy: messaging patients).

## Beaconly (product analytics and session replay)
Status: rejected in review SEC-031 (June 2025). Session replay captured form fields, including patient data entered in the clinical app. No BAA offered. Uses EU subprocessors without standard contractual clauses. Do not re-approve without a new full review.

## Datadog (observability)
Status: approved. BAA signed, covering APM and Logs on the US1 site only. Even with the BAA, logs must not contain PHI or payment data; use the field allowlist.

## StandupPal (Slack app)
Status: not reviewed. Under the Slack app policy, apps that request only chat:write in a single channel and read no messages are low risk and can be approved self-service by IT.

## Redline Security (penetration testing)
Status: approved. Authorized for the Q4 2026 assessment of app.example.com under MSA and NDA. Findings go to AppSec.
