# License history for mema

This file records the licensing history of mema so that downstream users
can clearly see which terms apply to which versions.

## v2.0.0 through v2.8.0 — MIT License

Versions v2.0.0, v2.1.0, v2.1.1, v2.2.0, v2.3.0, v2.4.0, v2.5.0, v2.5.1,
v2.6.0, v2.7.0, and v2.8.0 were released under the **MIT License**. Those
versions remain MIT-licensed at their published git tags on
`github.com/machtsinnch/mema`. Anyone is free to clone, fork, use, and
distribute those specific tagged versions under MIT terms.

The original MIT license text for those versions is preserved at
[`LICENSE-MIT-PRE-V2.9.md`](LICENSE-MIT-PRE-V2.9.md).

## v2.9.0 onward — Business Source License 1.1

Starting with **v2.9.0** (2026-05-15), mema is licensed under the
**Business Source License 1.1** (BSL). BSL is a source-available
license used by Sentry, HashiCorp Terraform/Vault, CockroachDB, and
MongoDB (formerly):

- **The source code remains public** and you may read it, audit it,
  fork it, and use it for development, testing, evaluation, academic
  research, and internal/personal non-commercial use.
- **Production use** of mema — i.e. running it as part of a service
  that processes real workload, customer data, or revenue-generating
  product — **requires a separate commercial license** from the
  Licensor.
- **Automatic conversion to Apache 2.0 on 2030-05-15** (the Change
  Date). Four years after the v2.9.0 release, the license
  automatically becomes the permissive Apache License 2.0.

The full BSL 1.1 text is at [`LICENSE`](LICENSE). Commercial license
inquiries: contact the Licensor.

## Why the change

The MIT versions (v2.0.0–v2.8.0) established mema as a serious
governed-memory substrate and produced our first external-benchmark
result (LongMemEval Hit@5 = 84.1% at v2.8.0). Going forward, mema
needs sustained engineering investment to close the remaining gaps
versus Zep / Hindsight / Mem0 and to deliver the Swiss-enterprise
trust features (strict policy mode, audit replay, jurisdiction
routing) on a production-quality footing. BSL is the standard way
to fund that work while keeping the source open for the audit and
academic uses that matter most to mema's market.
