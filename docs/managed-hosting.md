# Managed hosting: what's generic here vs. what belongs to a provider

Status: **Accepted** — 2026-10-23

## Decision

Kept supports being run by someone other than the end user — a managed-
hosting provider who operates a Kept server on a customer's behalf. This
repository implements only the generic, independently-useful primitives
that any such provider needs, never a specific provider's business logic.

This document exists because a managed-hosting service built on top of
Kept, developed in a separate private repository, is the first consumer
of these primitives, and it's worth being explicit about the boundary so
that boundary doesn't erode over time.

## What's in this repo (generic, optional, off by default)

- `KEPT_SETUP_TOKEN` (+ `KEPT_SETUP_TOKEN_EXPIRES_AT`): gates first-admin
  creation behind a one-time token, for instances that are automatically
  provisioned and internet-reachable before anyone has had a chance to
  create an account. Self-hosters who set up their own first account
  immediately don't need this and aren't affected.
- `KEPT_MANAGED_HOSTING`, `KEPT_MANAGED_PROVIDER_NAME`,
  `KEPT_MANAGED_ACCOUNT_URL`: generic "this instance is managed, by this
  provider, manage your account here" metadata. Surfaced in Settings and
  in a one-time welcome note. Works for any provider's name/URL.
- `KEPT_STORAGE_QUOTA_BYTES`: a storage allocation, enforced with
  `507 Insufficient Storage` on uploads/imports that would exceed it.
  Unset means unlimited, matching today's self-host behavior.
- `KEPT_EXTERNAL_BACKUPS`: hides the local backup-scheduler UI so it
  isn't presented as authoritative when a provider's own backup system
  is the real one.
- `GET /api/health`: a safe, secret-free liveness/readiness check any
  provisioner or load balancer can poll.
- `KEPT_METRICS_TOKEN`: lets a provider's own monitoring read
  `/api/settings/storage` (with a matching `X-Kept-Metrics-Token`
  header) without a user session, so it can compare its own disk
  measurement against what Kept reports without ever holding the
  customer's password.
- A documented `402` + `{"code": "CLOUD_SUSPENDED"}` response shape from
  *upstream of Kept* (a provider's own suspension gateway, not Kept
  itself) that Kept's own web/native clients recognize and show as a
  billing-paused message rather than a generic network error.

None of this requires knowing who the provider is, what they charge, how
their billing works, or anything about their infrastructure. A different
managed-hosting provider could set the exact same env vars and get the
exact same behavior.

## What does *not* belong here

Provider-specific business logic stays in that provider's own, private
repository: billing/subscription verification, customer account records,
provisioning/orchestration of the underlying containers or hosts,
suspension/retention lifecycle policy, backup *implementation* (restic,
B2, schedules, retention windows), support ticketing, release-rollout
orchestration, pricing, and advertising copy. This repo's job ends at
"here's a generic hook"; a provider's job is everything built on top of
that hook.

That provider's own architecture decision — including why it runs
ordinary Kept server instances instead of a bespoke sync/vault protocol —
is recorded in its private repository's `docs/architecture-decision.md`.
