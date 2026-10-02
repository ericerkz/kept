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

## Connect an existing Kept account

1. Sign in to Kept with your existing local account.
2. Open **Settings**, then **Security**.
3. Select **Connect SSO account** for the configured provider.
4. Complete the provider sign-in and consent flow.

Kept links the provider's stable issuer and subject identifiers to the signed-in Kept account. A provider identity cannot be linked to two Kept accounts. Disconnecting SSO requires a usable local password so an account cannot accidentally lose its only sign-in method.

## New-user provisioning

Automatic user creation is off by default. Set this only when everyone allowed through the provider should receive a new enabled Kept account:

```text
KEPT_OIDC_AUTO_PROVISION=1
```

An automatically provisioned user initially signs in through SSO only. They can set a local password from their profile menu if they want a fallback login or need to disconnect SSO.

## Optional email auto-linking

Explicit linking from Settings is the recommended path. If your provider has authoritative, verified email addresses and you want first-time SSO login to link automatically to exactly one enabled Kept user with the same email, set:

```text
KEPT_OIDC_AUTO_LINK_EMAIL=1
```

This is disabled by default because matching by email is less deliberate than linking while already authenticated. Kept only auto-links an email the provider marks as verified and only when exactly one enabled Kept account matches it.

## Notes

- Kept supports one configured upstream OIDC provider per server.
- GitHub's standard OAuth service is not itself an OIDC provider. Use an OIDC-capable broker or identity provider in front of GitHub if GitHub should be the upstream login.
- Localhost HTTP issuers are accepted for development. Production issuers should use HTTPS.
