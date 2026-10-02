# OpenID Connect single sign-on

Kept can use one OpenID Connect (OIDC) provider as an additional sign-in method. This works with standards-based providers such as Authentik, Pocket ID, Google, Keycloak, and compatible self-hosted identity providers.

OIDC does not replace Kept's authorization model. A provider identity is linked to one Kept user, and that user retains their normal Kept role, note ownership, sharing permissions, and settings.

## Provider setup

Create an OIDC application in your identity provider and register this redirect URI:

```text
https://your-kept.example/api/auth/oidc/callback
```

Set the following environment variables, then restart Kept:

```text
BASE_URL=https://your-kept.example
KEPT_OIDC_ISSUER=https://identity.example
KEPT_OIDC_CLIENT_ID=kept
KEPT_OIDC_CLIENT_SECRET=your-client-secret
KEPT_OIDC_NAME=Your provider name
```

`KEPT_OIDC_CLIENT_SECRET` is optional for public clients when the provider permits PKCE without a secret. The issuer must be the provider's OIDC issuer URL, not merely its login page. Kept discovers the provider metadata from the issuer.

The default scopes are `openid profile email`. Override them with `KEPT_OIDC_SCOPES` if your provider requires different scopes.

## Connect a Kept account

Every user must first have a local Kept account. OIDC identities do not automatically create accounts and are not matched to accounts by email.

1. Sign in to Kept with your existing local account.
2. Open **Settings**, then **Security**.
3. Select **Connect SSO account** for the configured provider.
4. Complete the provider sign-in and consent flow.

Kept links the provider's stable issuer and subject identifiers to the signed-in Kept account. A provider identity cannot be linked to two Kept accounts. The user's local password remains available as a fallback and is required for account-management actions such as changing the password or deleting the account.

## Notes

- Kept supports one configured upstream OIDC provider per server.
- GitHub's standard OAuth service is not itself an OIDC provider. Use an OIDC-capable broker or identity provider in front of GitHub if GitHub should be the upstream login.
- Localhost HTTP issuers are accepted for development. Production issuers should use HTTPS.
