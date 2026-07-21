# Security policy

## Supported versions

Security fixes are applied to the latest code on `main`. There are no supported
release branches yet.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
**Report a vulnerability** link on the repository's Security tab to send a
private report to the maintainer.

Include the affected component, reproduction steps, impact, and any suggested
mitigation. You should receive an acknowledgement within seven days. The
maintainer will coordinate disclosure after a fix is available.

## Scope

One Night LLM is a local loopback application. Its browser UI and game service
are not designed for untrusted public-network deployment. Reports about secret
role disclosure, session isolation, credential handling, prompt/tool boundary
bypasses, or unintended network access are especially useful.
