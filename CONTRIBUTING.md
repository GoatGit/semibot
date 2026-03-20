# Contributing to Semibot

This document is a first draft.

## Before You Contribute

Semibot is developed under an open-core strategy:

- Public Core is source-available
- internal work directories remain private
- brand use is restricted by `TRADEMARKS.md`
- all external contributions require acceptance of `CLA.md`

If you are not willing to accept the CLA, do not submit a pull request.

## What We Accept

We generally welcome:

- bug fixes in Public Core
- tests
- documentation improvements for Public Core
- packaging, build, release, and installation improvements
- small usability improvements that do not expose internal-only systems

## What We Usually Do Not Accept

We generally avoid accepting public contributions that:

- add or expose internal-only features;
- introduce private integrations, customer-specific behavior, or secrets;
- change trademarked branding without approval;
- copy code that you do not have the right to contribute.

## Contribution Process

1. Open an issue first for significant changes.
2. Confirm your change belongs in Public Core.
3. Complete the CLA process.
4. Submit a focused pull request with tests where appropriate.
5. Be prepared to revise your change based on review.

## Coding Expectations

- Keep changes focused and reviewable.
- Do not commit generated artifacts unless explicitly requested.
- Do not include secrets, tokens, or private endpoints.
- Keep documentation and tests aligned with behavior changes.
- Preserve the release/install path when changing build or packaging code.

## License and Brand

By contributing, you agree to the contribution terms in `CLA.md`.

Your contribution is also subject to:

- `LICENSE`
- `TRADEMARKS.md`

Submitting code does not grant any right to use the Semibot trademark for your
own product, service, or distribution.

## Maintainer Discretion

Maintainers may reject contributions that do not fit the Public Core boundary,
even if the code is technically sound.
