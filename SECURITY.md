# Security policy

## Scope

Raw Coding Agent is a local learning project. It is not a security sandbox.
The agent can read and write files in its workspace and execute shell commands.
`auto` approval allows tool calls without a human approval step.

Do not run it in a directory containing production credentials, private keys,
customer data, or other sensitive files. Treat `--remote` and `--public` as
network exposure: authenticated users can access the application, and remote
providers or tunnels may see conversation content, source code, and command
output.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Email the maintainer through
the contact information on the GitHub profile, with reproduction steps,
impact, and a minimal proof of concept. Remove secrets from reports.

This project has no guaranteed response time or supported security SLA.
