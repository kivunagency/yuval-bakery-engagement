# Move this into the app, do not leave it here

Rule 27. This directory was copied at bootstrap so that the registry exists before the
first API route does. It is NOT in its final home yet.

When the app skeleton is created, move `lib/` under the server layer (on egoz-maniv that
is `output/frontend/src/lib/server/agent-ops`), wire the MCP endpoint, and delete this file.

Three things are yours to implement and none of them have defaults:

    lib/auth.ts       resolvePrincipal, who the caller is
    lib/auditlog.ts   a persistent sink, not console
    SECURITY.md       filled in for THIS system, and it is a blocking gate

deploy-engineer blocks PRODUCTION if a MUST in SECURITY.md is unmet.
