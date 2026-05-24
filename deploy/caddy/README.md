# Caddy — host-level reverse proxy + TLS

Caddy terminates TLS at the public edge of the staging environment
(`api-staging.tchopnow.app → 127.0.0.1:3001`) and runs **on the host**,
not inside Docker Compose. The active config is `./Caddyfile`.

## Why host-level (not in compose)

| Concern                    | Compose Caddy                        | Host Caddy (chosen)                                     |
| -------------------------- | ------------------------------------ | ------------------------------------------------------- |
| Port 80 + 443 binding      | Compose port-map + iptables rules    | Native — Caddy owns it                                  |
| Let's Encrypt cert storage | Bind-mounted `/var/lib/caddy` volume | Native — `/var/lib/caddy`                               |
| Cert auto-renewal          | Survives compose restarts via volume | Survives `apt upgrade`, droplet reboot, container churn |
| Operational surface        | One more container to monitor        | Standard `systemctl status caddy`                       |
| First-deploy friction      | Compose recipe + ACME hand-off       | `apt install caddy` + `sudo systemctl reload caddy`     |

For a single-droplet pilot deploy, the host-level pattern is the canonical
choice — that's what Caddy's own docs recommend. When we move to Hetzner
production we may revisit (e.g. if we add a 2nd container fronted by a
load balancer, the LB itself does TLS and Caddy goes away).

## How to update the live config

1. **Edit this file** in the repo, open a PR, get it merged through
   the normal CD flow
2. **SCP to the droplet** (CD doesn't currently sync Caddy automatically
   — see "Future work" below):

   ```bash
   scp -i ~/.ssh/do_ed25519 \
     deploy/caddy/Caddyfile \
     root@157.230.125.224:/etc/caddy/Caddyfile
   ```

3. **Validate + reload**:

   ```bash
   ssh -i ~/.ssh/do_ed25519 root@157.230.125.224 \
     "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && \
      systemctl reload caddy"
   ```

   `caddy validate` will reject the file before reload if there's a
   syntax error. `systemctl reload` is graceful — no in-flight TLS
   connection is dropped.

4. **Smoke test**:

   ```bash
   curl -sI https://api-staging.tchopnow.app/health | head -3
   # Expected: HTTP/2 200, alt-svc: h3=":443"; ma=2592000
   ```

## How to roll back a bad Caddy change

```bash
# On the droplet
sudo systemctl stop caddy
# Edit /etc/caddy/Caddyfile by hand back to the previous content
sudo systemctl start caddy
```

If syntax is so broken that Caddy won't start, edit the file as root
until `caddy validate` passes. There is no second Caddy on the droplet
to fall back to — TLS termination is offline during recovery.

## Future work — automate the Caddyfile sync via CD

Currently `cd-staging.yml` deploys the API container but does NOT
sync this Caddyfile. If you change this file, you must SCP manually
(steps above). Tracked as a follow-up; the auto-sync would be:

1. SCP `deploy/caddy/Caddyfile` to `/etc/caddy/Caddyfile`
2. `caddy validate` — abort deploy if invalid
3. `systemctl reload caddy`

It's deliberately deferred because Caddy config changes very rarely
(maybe once a quarter — add a new subdomain, tighten HSTS) and the
manual procedure is well-documented above.

## Related

- `deploy/docker-compose.staging.yml` — the API container Caddy proxies to
- `.github/workflows/cd-staging.yml` — the deploy pipeline (does NOT manage Caddy)
- `chopnow-docs/docs/architecture/infrastructure.md` — full system topology
