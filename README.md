# Craner Data Inspector Web Export

React Web UI + Node.js export service for querying InfluxDB v2 and exporting large result sets without building the file in the browser.

## Development

```bash
npm install
npm run dev
```

- Client: `http://localhost:1420`
- API server: `http://localhost:3001`

The client calls the API server through `VITE_API_BASE`, defaulting to `http://localhost:3001`.

## Production Build

```bash
npm run build
npm run server:start
```

The server also serves the built `dist/` frontend.

## Environment

- `PORT`: API server port, default `3001`.
- `CLIENT_ORIGIN`: allowed CORS origin for development, default `http://localhost:1420`.
- `VITE_API_BASE`: frontend API base URL, default `http://localhost:3001`.

## Export Behavior

- `xlsx_by_day`: one XLSX file with one sheet per local date.
- `csv_by_day`: one CSV per local date; multiple days are zipped.
- `csv`: one combined CSV file.

Exports are handled by the Node server. It splits the query time range into 10-minute chunks, queries InfluxDB chunk by chunk, and writes CSV/XLSX output through streams. Progress is pushed to the browser over SSE, and completed jobs expose a download URL.

Temporary export files are written under `server/tmp/exports/{jobId}` and old files are cleaned periodically.
