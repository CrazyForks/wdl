# inspection-demo

Small WDL demo for an inspection workflow:

- R2 stores uploaded images.
- D1 stores inspection rows and comments.
- KV stores visit/submission counters.
- ASSETS serves the browser JavaScript and CSS.

Uploads store objects under `inspections/<uuid>/<safe-file-name>` so files with
the same original name become separate R2 objects. R2 still follows normal
key-value semantics: writing the exact same key would overwrite the object.

Run locally against the dev compose stack:

```bash
export ADMIN_TOKEN=local-dev-token
export CONTROL_URL=http://admin.test:8080
export CONTROL_CONNECT_HOST=localhost

wdl d1 create --ns demo inspection-main
wdl deploy examples/inspection-demo --ns demo
```

Open:

```text
http://localhost:8080/inspection-demo/
Host: demo.workers.local
```

For a browser, add `demo.workers.local` to `/etc/hosts` or use a local proxy
that sets the Host header.
