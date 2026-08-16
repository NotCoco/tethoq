# Accounts and remote access

## Current status

Tethoq does not yet have end-to-end account-backed device enrollment. The
public repository contains an optional account foundation that operators may
configure for their own deployment.

- The website contains environment-driven Supabase email and Google OAuth
  flows plus checked-in row-level-security migrations.
- No hosted account project, OAuth credential, service-role key, or deployment
  configuration is bundled with the community source tree.
- A deployer must supply the documented public environment values and configure
  exact Auth URLs in their own account service before those flows are usable.
- A native mobile redirect URI has not been implemented or allowlisted.
- The phone currently connects through the short-lived QR pairing flow.
- The account dashboard schema can represent users, workspaces, computers,
  devices, enrollment challenges, revocation, and audit events, but there is no
  production enrollment API connecting those records to Bridge and Relay.

The existing QR flow remains the working, security-reviewed path until the
account control plane below is implemented and deployed.

## Product decision

Tethoq stays useful without an account.

| Capability | Community build | Official hosted build |
|---|---|---|
| Local desktop and local agents | No sign-in | No sign-in |
| Direct/LAN pairing | Available | Available |
| QR pairing | Available | Available as a private fallback |
| Tethoq cloud discovery and relay | Not bundled or required | Requires a Tethoq account |
| Google sign-in | Not required; a self-host may configure its own account service | Available when cloud access is chosen |
| Provider/harness login | Owned by each local harness | Owned by each local harness |

Do not put a mandatory login wall in front of the desktop workspace. Show a
quiet account entry point in Settings and at the moment a user chooses a hosted
feature such as **Use on phone**. A signed-out official build remains a complete
local application.

The open-source repository must default to community mode. Community builds
must not contact Tethoq infrastructure, include private service credentials, or
fail because the hosted account service is absent. If hosted integration is
kept private later, it should implement a small public account-service
interface rather than forking the application.

## Why Google sign-in does not replace device pairing

An account proves which workspace a person may see. It does not prove that a
particular phone is the approved device holding a private key, and it does not
authorize arbitrary commands on a computer.

Every phone still creates its own Ed25519 key in platform secure storage. Every
computer still grants a revocable credential to that public key. Every remote
action still carries the existing short-lived device signature and is checked
by Bridge. The hosted service discovers and brokers enrollment; it does not
become the final command-approval authority.

This separation keeps a stolen web session, compromised relay, or database
reader from silently turning into coding-agent control.

## Account-backed no-QR flow

1. The user chooses **Use on phone** on the computer and signs in with Google.
2. The computer registers its stable Bridge host identity in the user's
   workspace and opens an outbound authenticated relay connection.
3. The phone signs into the same workspace and creates or loads its device key.
4. The phone lists that workspace's computers from a bounded account API; it
   never scans server folders or provider state.
5. The user selects a computer. A short-lived enrollment request containing
   the phone public key is delivered to that Bridge.
6. The computer shows the requesting device and asks for approval the first
   time. On approval, Bridge issues the same host-signed device credential used
   by QR pairing.
7. The service issues a short-lived, device-specific relay authorization. The
   phone and computer then use the existing end-to-end encrypted transport and
   signed action protocol.

After this first approval, future connections are automatic while the device,
computer, workspace membership, and relay grant remain valid. QR remains an
offline/private-network fallback and a recovery route for self-hosted users.

## Required hosted control-plane work

The production path is not complete until all of these exist:

1. Configure an account project and inject only its public URL/publishable key
   into an authorized hosted deployment.
2. Finish Google OAuth production branding/review and add the exact native
   redirect only when the signed native callback exists.
3. Inject public project URL/publishable keys only into official clients.
   Google client secrets and Supabase service-role keys remain server-only.
4. Explicit computer runtime identity and computer-to-device grant records.
5. Authenticated, rate-limited enrollment endpoints that validate workspace
   membership, expiry, device/computer state, and replay/idempotency.
6. Per-device, short-lived relay authorization. The current shared room token
   is not the hosted production design.
7. Bridge account sign-in and registration, mobile Google sign-in/deep-link
   handling, computer discovery, first-device approval, revocation, sign-out,
   and recovery UI.
8. Audit logs that contain identifiers and outcomes, never OAuth tokens,
   pairing secrets, private keys, relay credentials, prompts, or repository
   content.
9. Tests covering wrong-account access, revoked membership/device/computer,
   expired or replayed enrollment, relay-token theft, logout, offline fallback,
   and migration from QR-paired devices.

Until those items are complete, UI and marketing copy must not claim that
signing into the phone removes the QR step.

## Distribution boundary

Use a build-time edition capability, not a cosmetic runtime switch:

- `community` is the repository and release default. Its account-service
  implementation is disabled and local/QR operation is always available.
- `hosted` is used by signed official releases and receives only public account
  configuration at build time. It enables optional account and cloud features.
- Server secrets never ship in either client.
- A self-hosted operator can supply an implementation of the same account,
  enrollment, and relay contracts without depending on Tethoq's service.

The edition flag may enable hosted entry points, but authorization must always
come from server-validated account state plus Bridge-validated device
credentials. Never use the edition flag itself as a security decision.
