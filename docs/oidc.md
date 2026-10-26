# OpenID Connect single sign-on

Kept can use one OpenID Connect (OIDC) provider as an additional sign-in method, or optionally require SSO after setup. This works with standards-based providers such as Authentik, Pocket ID, Google, Keycloak, and compatible self-hosted identity providers.

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

`KEPT_OIDC_CLIENT_SECRET` is optional for public clients when the provider permits PKCE without a secret. The issuer must exactly match the `issuer` value in the provider's OIDC discovery document, including any trailing slash; it is not merely the provider's login page. Kept discovers the remaining provider metadata from that issuer.

The default scopes are `openid profile email`. Override them with `KEPT_OIDC_SCOPES` if your provider requires different scopes.

## Google

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. Configure **Google Auth Platform > Branding**.
3. Under **Audience**, choose **Internal** for a single Google Workspace organization or **External** for regular Google accounts. If an External app is still in testing, add each account that will test it as a test user.
4. Open **Clients**, create a client, and choose **Web application**.
5. Add this exact **Authorized redirect URI**:

   ```text
   https://your-kept.example/api/auth/oidc/callback
   ```

6. Copy the generated client ID and client secret into Kept:

   ```text
   BASE_URL=https://your-kept.example
   KEPT_OIDC_ISSUER=https://accounts.google.com
   KEPT_OIDC_CLIENT_ID=123456789.apps.googleusercontent.com
   KEPT_OIDC_CLIENT_SECRET=your-google-client-secret
   KEPT_OIDC_NAME=Google
   ```

Kept uses Google's server-side authorization-code flow, so an Authorized JavaScript origin is not required for this integration. The redirect URI must match exactly, including its scheme, hostname, port, and path. See Google's [OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect).

## Authentik

1. In the Authentik administration interface, open **Applications > Applications**.
2. Create an application named `Kept` and an associated **OAuth2/OpenID Provider**. The **Create with provider** flow can create both together.
3. Select a normal authorization flow and set the client type to **Confidential**.
4. Add this exact redirect URI using strict matching:

   ```text
   https://your-kept.example/api/auth/oidc/callback
   ```

5. Select a signing certificate so Authentik signs tokens asymmetrically, and make the `openid`, `profile`, and `email` scope mappings available.
6. Copy the provider's client ID and client secret.
7. Copy the issuer exactly as Authentik publishes it. With the recommended per-provider issuer mode and an application slug of `kept`, it normally looks like this:

   ```text
   BASE_URL=https://your-kept.example
   KEPT_OIDC_ISSUER=https://auth.example.com/application/o/kept/
   KEPT_OIDC_CLIENT_ID=your-authentik-client-id
   KEPT_OIDC_CLIENT_SECRET=your-authentik-client-secret
   KEPT_OIDC_NAME=Authentik
   ```

The trailing slash in Authentik's per-provider issuer is significant. If you use Authentik's global issuer mode, copy the `issuer` value from the application's discovery document rather than assuming the URL. Application policies and group bindings can restrict which Authentik users may connect Kept. See Authentik's [OAuth2/OpenID provider documentation](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/).

## Pocket ID

1. Sign in to Pocket ID as an administrator.
2. Open **Settings > OIDC Clients** and select **Add OIDC Client**.
3. Name the client `Kept`.
4. Add this callback URL:

   ```text
   https://your-kept.example/api/auth/oidc/callback
   ```

5. Enable PKCE if that option is shown. Keep **Public Client** disabled when using the generated client secret.
6. Optionally limit access to selected Pocket ID groups.
7. Save the client and copy its client ID and client secret into Kept:

   ```text
   BASE_URL=https://your-kept.example
   KEPT_OIDC_ISSUER=https://id.example.com
   KEPT_OIDC_CLIENT_ID=your-pocket-id-client-id
   KEPT_OIDC_CLIENT_SECRET=your-pocket-id-client-secret
   KEPT_OIDC_NAME=Pocket ID
   ```

Pocket ID uses the instance URL as its issuer. Confirm the exact value by opening `https://id.example.com/.well-known/openid-configuration` and copying its `issuer` field. See Pocket ID's [OIDC client authentication documentation](https://pocket-id.org/docs/guides/oidc-client-authentication).

## Apply and verify

Recreate or restart Kept after changing its environment. With Docker Compose:

```bash
docker compose up -d
```

You can verify that the issuer publishes usable discovery metadata before connecting an account:

```bash
curl -s "${KEPT_OIDC_ISSUER%/}/.well-known/openid-configuration" | jq .issuer
```

Authentik's global issuer mode is an exception: its discovery document can remain under the application's `/application/o/<slug>/` path even when the published issuer is the instance root. Use the discovery URL shown by Authentik in that configuration.

## Connect a Kept account

Existing users connect their provider identity to their Kept account explicitly. Accounts are never matched by email.

1. Sign in to Kept with your existing local account.
2. Open **Settings**, then **Security**.
3. Select **Connect SSO account** for the configured provider.
4. Complete the provider sign-in and consent flow.

Kept links the provider's stable issuer and subject identifiers to the signed-in Kept account. A provider identity cannot be linked to two Kept accounts. Unless password sign-in is explicitly disabled below, the user's local password remains available as a fallback. Passwords are still required for account-management confirmations such as changing the password or deleting the account.

If **Self-registration** is enabled, a new user can instead select the provider on the sign-in page. After verifying with the provider, they complete a Kept account form with their username, display name, email and password. This explicitly creates a regular user account linked to that provider identity. The password is still used for sensitive account confirmations, even on an SSO-only server. Provider verification alone never creates an account or links an existing account by email.

The existing **Require approval** setting also applies to OIDC registration. When enabled, the new account cannot sign in until an administrator approves it. Registration links expire after ten minutes and can only be used once. Registration is available in both browser and native SSO flows; native users finish the form in the provider browser before returning to Kept.

## Require single sign-on

Password sign-in is enabled by default. To require SSO:

1. Finish setting up Kept and configuring OIDC with password sign-in still enabled.
2. Have every user connect their SSO account in Settings. Include at least one enabled administrator and test that administrator's SSO sign-in.
3. Set `KEPT_DISABLE_PASSWORD_LOGIN=1` and recreate or restart Kept. `true` is also accepted.

Kept refuses to start with this setting unless `BASE_URL`, a valid OIDC issuer and client ID are configured and an enabled administrator is linked to that exact issuer. Startup validation checks local configuration and account links; it does not require the identity provider to be online.

The sign-in page offers **Continue with your provider**. Password login is rejected by both browser and native/API password-login endpoints. When self-registration is enabled, new users register through OIDC as described above; password-only registration is blocked. Email invitations are paused, including acceptance of existing invitations, because that flow creates a password session. Existing accounts, passwords, registration/invitation settings, and sessions are retained. Account permissions and optional API/OAuth access remain governed by their existing settings.

Connected users cannot disconnect SSO while it is required. Existing users with an active session can still connect an unlinked SSO identity. A signed-out existing user without a linked identity needs password sign-in temporarily re-enabled so they can sign in and connect it. They should not register a second account. New users can register through OIDC if self-registration is enabled.

For recovery, remove `KEPT_DISABLE_PASSWORD_LOGIN` (or set it to `0`) and recreate or restart Kept. Your existing passwords work again. Kept never automatically enables password sign-in when the provider is unavailable. Existing sessions are not revoked by this setting; revoke them separately if needed. Device-only libraries do not require server authentication and are unaffected.

Use updated mobile bundles for the shared login page. The native local-to-server sign-in sheets also need to honor the server's policy; older sheets can still offer SSO, but may show password controls whose requests the server will reject.

## Notes

- Kept supports one configured upstream OIDC provider per server.
- GitHub's standard OAuth service is not itself an OIDC provider. Use an OIDC-capable broker or identity provider in front of GitHub if GitHub should be the upstream login.
- Localhost HTTP issuers are accepted for development. Production issuers should use HTTPS.
