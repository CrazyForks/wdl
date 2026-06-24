# DO demo

Local Durable Object smoke worker for WDL. It exercises ordinary `stub.fetch()`,
native SQLite-backed `ctx.storage.sql`, the alarm shim, and normal WebSocket
upgrade pass-through.

```bash
docker compose up -d --wait gateway scheduler

cd examples/do-demo
npm install
cd ../..

export ADMIN_TOKEN=local-dev-token
export WDL_NS=demo
CONTROL_CONNECT_HOST=127.0.0.1 wdl deploy examples/do-demo --ns demo --control-url http://admin.test:8080
```

HTTP checks:

```bash
curl -H "Host: demo.workers.local" "http://localhost:8080/do-demo/hit?room=alpha"
curl -H "Host: demo.workers.local" "http://localhost:8080/do-demo/status?room=alpha"
curl -H "Host: demo.workers.local" "http://localhost:8080/do-demo/alarm?room=alpha&delay_ms=1000"
sleep 2
curl -H "Host: demo.workers.local" "http://localhost:8080/do-demo/status?room=alpha"
```

Restart `do-runtime` and call `/hit` again to see memory reset while SQLite
storage keeps counting:

```bash
docker compose restart do-runtime
curl -H "Host: demo.workers.local" "http://localhost:8080/do-demo/hit?room=alpha"
```

WebSocket check with `wscat`:

```bash
npx wscat -H "Host: demo.workers.local" -c "ws://localhost:8080/do-demo/ws?room=alpha"
```

Send any text message; the response includes the object's in-memory counter and
SQLite-backed WebSocket message count.
