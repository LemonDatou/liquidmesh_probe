# LiquidMesh Probe

LiquidMesh Probe is a lightweight sampler and dashboard for monitoring whether a LiquidMesh route is likely to pass a fixed Binance Wallet DEX gas-limit workflow.

The project is designed for a two-direction swap workflow:

- `USDT -> target token`
- `target token -> USDT`

It records every probe result locally as JSONL, serves a web dashboard, and estimates how long it may take to complete a configured number of round trips based on recent probe history.

## Components

```text
scripts/liquidmesh_wrapper_probe.mjs  # sampler process
scripts/liquidmesh_web.mjs            # web dashboard and API
```

Runtime data is stored under:

```text
data/liquidmesh_probe/samples/YYYY-MM-DD.jsonl
```

The data directory is intentionally ignored by Git.

## Configuration

Create `liquidmesh.env` in the project root. Do not commit this file.

Required fields:

```dotenv
API_Key="..."
Public_Key="..."
Private_Key="..."
WALLET="0x..."
OUTPUT_TOKEN="0x..."
PROBE_AMOUNT="..."
REVERSE_AMOUNT="..."
```

Optional second API credential set:

```dotenv
API_Key2="..."
Public_Key2="..."
Private_Key2="..."
```

The sampler alternates API credential sets when both are present. This is useful when each credential is rate-limited independently.

## Running The Sampler

Run continuously:

```bash
node scripts/liquidmesh_wrapper_probe.mjs --samples 0 --interval-ms 500
```

Run a small manual test without writing logs:

```bash
node scripts/liquidmesh_wrapper_probe.mjs --samples 3 --log false
```

Useful options:

```text
--wallet <address>          override WALLET from liquidmesh.env
--input-token <address>     override INPUT_TOKEN, defaults to BSC USDT
--output-token <address>    override OUTPUT_TOKEN from liquidmesh.env
--amount <wei>              forward swap amount
--reverse-amount <wei>      fallback reverse swap amount
--interval-ms <ms>          sampler interval, minimum 500ms
--log-dir <path>            JSONL output directory
--stdout sample|summary|json
```

For long-running mode, stdout defaults to a low-volume summary log. Full per-sample data is still written to JSONL.

## Running The Dashboard

Local-only:

```bash
node scripts/liquidmesh_web.mjs --host 127.0.0.1 --port 19988
```

LAN-accessible:

```bash
node scripts/liquidmesh_web.mjs --host 0.0.0.0 --port 19988
```

Open:

```text
http://127.0.0.1:19988/
```

API:

```text
GET /api/status
GET /api/public-status
```

Production exposes two views from the same web process:

```text
/liquidmesh/        public compact dashboard
/liquidmesh_probe/  full internal dashboard
```

## Pass Criteria

Each sample is reduced to a boolean:

```text
PASS  = V4 is excluded and the quote uses one V3 dex, 1412-byte inner calldata,
        and a 155000 LiquidMesh gas estimate
BLOCK = route/gas/calldata does not match the target path or the request fails
```

The accepted single-dex route names are `pancakeswap_v3` and `uniswap_v3`.

The current sampler records the following useful fields:

```text
ts
ok
direction
liquidMeshEstimatedGasLimit
route
innerBytes
outputAmount
minOutputAmount
error
```

The dashboard uses `ok` as the main pass/fail signal and keeps raw fields for later offline analysis.

## Dashboard Metrics

The dashboard currently shows four windows:

```text
10s, 1m, 5m, 1h
```

For each window:

- The 1m window is calculated directly from per-sample probe data in the current minute.
- Longer windows average the previous window level by direction first, then take the weaker direction.
- Overall percentage is the bottleneck rate of the two directions.
- Direction details are shown separately.
- If the weaker direction is below the brushable tier, the card title includes that direction.
- Heatmaps use the same pass-rate definition as the corresponding window.

Status thresholds:

```text
> 70%  super smooth
>=50%  smooth
>=25%  brushable
>=10%  congested
>0% and <10%  severely congested
0%  fuse triggered
```

## Time Estimate

The dashboard estimates the time required to complete 4 round trips.

Current assumptions:

```text
target round trips: 4
target swaps: 8
direction switch time: 20s
refresh interval: 1.5s
sample lookup: nearest sample in the same direction
```

The 10-second window is recomputed every 10 seconds. Existing minute-based
windows and the time estimate keep their original once-per-minute refresh.

The full dashboard fetches its cached payload every 10 seconds and stops
automatic fetching after 20 minutes.

The public dashboard omits the 10-second card, returns only 24 history points,
shows a 24-hour trend, and fetches once per minute for at most 10 minutes. Each
browser's schedule starts when that page is opened. Reload the page to start a
new automatic refresh period after it expires.
Nginx serves the public page and public API through a shared cache so concurrent
visitors do not create proportional load on the Node process. API responses are
not cached by browsers, preventing stale shared-cache responses from being held
for another refresh interval.

## Data Retention

JSONL files can grow steadily when probing every 500ms. A typical production setup should keep recent raw JSONL only, for example:

```cron
20 3 * * * find /path/to/liquidmesh_probe/data/liquidmesh_probe/samples -maxdepth 1 -type f -name '*.jsonl' -mtime +7 -delete
```

## Security Notes

Never commit:

- `liquidmesh.env`
- API keys
- public/private LiquidMesh key material
- production sample data
- chatroom IDs or messaging webhook URLs
- server-specific deployment details

The repository intentionally ignores env files and runtime data.
