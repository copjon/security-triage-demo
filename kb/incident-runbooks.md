# Incident runbooks

## Exposed or leaked cloud credentials
Applies to any access key, token or secret that was committed to a repository, pasted in chat or otherwise exposed.
1. Deactivate and rotate the key immediately; do not wait for investigation. 2. Treat the key as compromised: bots scrape public GitHub within minutes, and deleting the commit does not remove it from forks or caches. 3. Page SecOps/IR and open an incident. 4. Review CloudTrail for every action taken with the key since the exposure. 5. If the key could reach PHI, start the PHI breach process. 6. Replace long-lived keys with IAM roles.

## Suspected account takeover
Signs of MFA fatigue include several push approvals in a short window and logins from impossible locations. Revoke all sessions, suspend the account, reset MFA factors, and contact the user through a verified out-of-band channel. Review mailbox forwarding rules, OAuth grants and recent payments or approvals made from the account.
