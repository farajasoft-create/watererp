# Security and hardening guide

How gERP protects TACHWASCO's data, and the settings and server steps to apply before go-live. Everything
under "Built in" is enforced by the code and covered by the automated tests; "Deployment" lists what the
person installing the server must do.

## Built in

### Identity and sign-in
- Passwords are stored as bcrypt hashes; at least 10 characters. Sign-in takes the same time whether or
  not the email exists, so accounts cannot be guessed.
- Two-step sign-in with an authenticator app (TOTP) and one-time recovery codes. The organisation can
  require it of administrators or of everyone (Settings → Security); users without it are made to enrol.
- Single sign-on with the organisation's identity provider (Microsoft Entra ID, Google Workspace) over
  OpenID Connect, limited to the organisation's email domains; SAML for Finance.
- Sessions are signed tokens in an HttpOnly cookie, valid for a week. Changing a password, deactivating a
  user or resetting two-step ends every session at once (token version).
- Public portals never use staff accounts: customers sign in with a texted code, job applicants with an
  account and a code by email and SMS, suppliers, tenants, donors, MSMEs and bidders with private links.
  Links and codes are stored only as SHA-256 hashes and expire or can be withdrawn.

### Access control
- Every API route declares the permissions it needs; the server checks them on each call from the user's
  current roles, never from what the browser says.
- Roles per module (standard ones, plus the organisation's own under Settings → Users → Custom roles).
- Record-level limits: users can be restricted to zones, departments or branches; Finance users to
  branches (requisitions, orders, stores, imprest and petty cash outside them are invisible).
- Segregation of duties is enforced where the law or practice requires it: nobody approves their own
  journal, payment, requisition, imprest, petty cash or sponsorship; tender evaluators cannot award;
  preparers and reviewers of audit working papers differ.
- API keys for other systems (Settings → Developers) act as a service user with only the roles that system
  needs; they are hashed, expire and can be revoked; administrators cannot hold them.

### Protection of the data
- Every change is written to the audit trail with who, when and from which address; documents, internal
  audit evidence and report runs also record who opened or downloaded them.
- Secrets the system keeps (SMS and email passwords, identity-provider secrets) are encrypted with
  AES-256-GCM using a key held outside the database.
- Uploaded files live in the database (GridFS), so they are covered by the same backups and access rules.
- Data subject requests (Data Protection Act s.26) are answered from Settings → Data protection; see
  `docs/data-protection.md`.

### Web and API
- HTTPS-only headers: HSTS (two years, preload), a strict Content Security Policy, no framing, no MIME
  sniffing, a tight referrer and permissions policy; the framework banner is switched off.
- Rate limits on every route, tighter on sign-in, codes, public forms and portals.
- Request bodies and queries are validated against schemas before any handler runs; unknown fields are
  dropped; database queries never take raw user input as operators.
- Writes to Finance accept idempotency keys so a retried payment is never posted twice.

## Deployment checklist

1. Run behind HTTPS only (a reverse proxy such as Nginx or IIS with a valid certificate); redirect HTTP.
2. Set `JWT_SECRET` and `SETTINGS_ENCRYPTION_KEY` to long random values (at least 32 characters) kept in the server's
   secret store, not in the code; different values per environment.
3. MongoDB: enable authentication, bind to the private network only, use a dedicated user with access to
   the gERP database only, and enable encryption at rest on the volume.
4. Require two-step sign-in for administrators at least (Settings → Security); for all staff when the
   identity provider is not used.
5. Give each person their own account; remove the seed/demo users; review users and roles quarterly
   (Settings → Users shows each user's roles and last sign-in).
6. Schedule the nightly backup and the monthly restore test (`docs/operations.md`).
7. Keep the server patched; update Node.js and dependencies monthly (`npm audit`, then the test suites).
8. Send the server and reverse-proxy logs to the ICT team's log store; review failed sign-ins weekly.
9. Restrict the scheduler endpoints (`/housekeeping`, deliveries) to the scheduler's address at the proxy.
10. Before go-live and yearly, have an independent penetration test; fix findings before the next release.
