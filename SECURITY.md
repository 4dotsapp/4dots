# Security

4dots encrypts everything in the browser, so bugs in the crypto, the API or the
way keys are derived matter. Thank you for looking.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately with GitHub's
[**Report a vulnerability**](https://github.com/4dotsapp/4dots/security/advisories/new)
button on the Security tab, and include steps to reproduce if you can.

You'll get a reply as soon as possible, and a fix will ship to
[4dots.app](https://4dots.app) before the details are made public.

## Scope

The design and its known limits are described in the
[security model](docs/README.md#security-model). In short: a four-digit code has
only 10,000 values, so 4dots relies on short expiry, burn-after-reading and rate
limits, and whoever runs the server could derive keys. Reports that only restate
those limits aren't vulnerabilities, but ideas for tightening them are welcome
as issues.
