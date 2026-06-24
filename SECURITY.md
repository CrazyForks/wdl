# Security Policy

## Supported Versions

Only the latest WDL platform release receives security fixes.

## Reporting A Vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting instead: open the repository's
**Security** tab and choose **Report a vulnerability**
(<https://github.com/wdl-dev/wdl/security/advisories/new>).

Include reproduction steps, the affected WDL release or commit, deployment
shape, and any relevant logs with secrets removed. Please allow the maintainers
a reasonable window to ship a fix before any public disclosure.

If the reporting form is unavailable, email <security@wdl.dev> instead.

## Scope

WDL is a multi-tenant Workers platform. Reports about tenant isolation, control
plane authorization, hidden/internal bindings, service or platform binding
authorization, secret handling, internal mesh authentication, Redis/Valkey state
integrity, image/runtime supply chain, and log or metric data exposure are
particularly welcome.
