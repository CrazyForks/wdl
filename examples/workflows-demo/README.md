# workflows-demo

Deploy this worker to smoke-test WDL Workflows in an environment:

```bash
wdl deploy examples/workflows-demo --ns demo
```

Useful routes:

- `GET /start?id=order-1&callback=1` creates an instance.
- `GET /start?id=dag-1&mode=parallel&steps=1` creates a DAG-shaped workflow with fan-out, intermediate joins, and a final join.
- `GET /status?id=order-1&steps=1` reads status and recent steps.
- `GET /event?id=order-1&message=approved` sends an approval event.
- `GET /pause?id=order-1`, `/resume`, `/restart`, `/terminate` exercise lifecycle APIs.
- `GET /progress/events` reads best-effort workflow progress callbacks from the `Progress` Durable Object.
- `GET /progress/clear` clears callback rows.

Modes for `/start`:

- `mode=default` records one step and completes.
- `mode=retry` fails once, then succeeds through `step.do` retries.
- `mode=nonretryable` throws `NonRetryableError`.
- `mode=parallel` records a visible DAG: `load-order` fans out into inventory/payment/risk steps, then joins into fulfillment/audit and a final `finish-order` step. Use `/status?id=<id>&steps=1` to inspect `dependencies`.
- `wait=1` waits for `/event`.
- `sleepMs=1000` sleeps before completing.
