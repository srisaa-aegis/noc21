# B3 — Performance probe at 300 000 applications

`npm run db:load-test-data` then `npm run perf:probe` (this file is its report, copied from
`var/perf/`). Sandbox: 4 vCPUs (shared), 16 GB, PostgreSQL 16 with `PG_SERVER_OPTIONS`, the API
built in-process for the reads and writes and as 2 separate processes (`API_WORKERS=2`) for the
workload. Timings vary by ±30–50 % between runs on this shared machine. "SQL" is the number of
statements of one call; "slowest SQL" is the slowest of them under `EXPLAIN ANALYZE` (run
separately, with parallel workers and JIT as configured for `psql`, so it may exceed the call's own
time). Reports are timed with `fresh=true` (the one-minute memo of N-16 is bypassed).

Budgets (80-test-plan §8.11): screens 500 ms · reports 1.5 s · save 300 ms · submit 500 ms ·
transition 200 ms · exports 15 s · workload p95 1 s with a 5 s pause between a user's requests.


| call | who | status | median ms | SQL | slowest SQL ms | seq scans of large tables |
|---|---|---|---|---|---|---|
| /applications?scope=mine&pageSize=all | citizen | 200 | 18 | 4 | 1.9 | — |
| /applications/37614 | citizen | 200 | 69 | 25 | 0.3 | — |
| /dept/tasks | dfs.officer | 200 | 166 | 5 | 111.1 | — |
| /dept/monitoring | dfs.officer | 200 | 153 | 7 | 96.3 | — |
| /dept/monitoring?includeDecided=true&page=3 | dfs.officer | 200 | 920 | 8 | 414.5 | applications, wf_instances |
| /dept/applications/106 | dfs.officer | 200 | 126 | 31 | 0.2 | — |
| /applications?scope=dept&text=tower&pageSize=50 | dfs.officer | 200 | 126 | 10 | 95.2 | — |
| /applications?scope=dept&text=20261100009&pageSize=50 | dfs.officer | 200 | 25 | 10 | 4.5 | — |
| /dept/tasks | load.dfo.6 | 200 | 60 | 5 | 13.1 | — |
| /dept/monitoring | load.dfo.6 | 200 | 397 | 7 | 206.1 | applications |
| /dept/monitoring?includeDecided=true&page=2 | load.dfo.6 | 200 | 999 | 8 | 478.2 | applications, wf_instances |
| /dept/monitoring?overdueOnly=true | monitor.hq | 200 | 106 | 7 | 77.8 | — |
| /dept/feedback-summary?months=12 | monitor.hq | 200 | 427 | 2 | 147.8 | application_feedback |
| /dept/reports/pendency?fresh=true | monitor.hq | 200 | 486 | 1 | 307.7 | wf_instances, applications |
| /dept/reports/statistics?fresh=true | monitor.hq | 200 | 795 | 2 | 446.6 | applications, payments |
| /dept/reports/consolidated?fresh=true | monitor.hq | 200 | 703 | 1 | 424.1 | applications, payments |
| /dept/reports/applications?fresh=true | monitor.hq | 200 | 659 | 2 | 343.6 | applications |
| /dept/reports/overdue?fresh=true | monitor.hq | 200 | 412 | 1 | 248.1 | wf_instances, applications |
| /dept/reports/sms?fresh=true | monitor.hq | 200 | 177 | 1 | 150.7 | — |
| /dept/reports/feedback?fresh=true | monitor.hq | 200 | 839 | 4 | 293.4 | application_feedback, applications |
| /dept/reports/challan?fresh=true | monitor.hq | 200 | 649 | 1 | 414.5 | applications, payments |
| /dept/reports/district?fresh=true | monitor.hq | 200 | 803 | 1 | 385.3 | applications, payments |
| /dept/reports/levels?fresh=true | monitor.hq | 200 | 794 | 2 | 365.2 | applications, payments |
| /dept/reports/statistics?level=MSB&from=2025-01-01&to=2025-12-31&fresh=true | monitor.hq | 200 | 116 | 1 | 111.5 | — |
| /dept/reports/applications?format=csv | monitor.hq | 200 | 6077 | 12 | 2953.9 | applications, wf_instances |
| /applications?scope=all&draftsOnly=true&sort=-days_idle&pageSize=100 | admin | 200 | 53 | 5 | 22.4 | — |
| /applications?scope=all&idleDays=90&pageSize=1 | admin | 200 | 492 | 4 | 237.3 | applications |
| /admin/accounts?portal=citizen&q=load12&pageSize=100 | admin | 200 | 20 | 3 | 4.1 | — |
| /admin/statuses | admin | 200 | 554 | 1 | 551.0 | process_log |
| /admin/unassigned-tasks | admin | 200 | 5 | 2 | 0.1 | — |
| /admin/escalations/preview | admin | 200 | 344 | 4 | 309.8 | wf_instances |
| /config/workflows/usage | admin | 200 | 432 | 3 | 254.1 | applications, wf_instances |

| write | status | ms | budget ms |
|---|---|---|---|
| create a draft (POST /applications) | 201 | 242 | 300 |
| save the whole application with the server assessment (PUT) | 200 | 327 | 300 |
| pay online (POST …/payment) | 200 | 160 | 300 |
| upload 21 documents (mean per upload) | 201 | 132 | 300 |
| submit (validation, number, workflow start) | 200 | 210 | 500 |
| decide: approve (workflow transition + snapshot) | 200 | 226 | 500 |
| workflow transition: submit a DFS note (POST …/tasks/:n/submit) | 200 | 192 | 200 |

Mixed workload: 100 concurrent users (5000 ms average pause) for 60 s over HTTP against 2 API process(es) — 1158 requests (19/s), p50 62 ms, p95 852 ms, p99 2083 ms, errors 0, at most 9 of the 20 pooled database connections busy at once.
  - /applications?scope=mine&pageSize=all: 162 requests, median 23 ms
  - /applications/37614: 154 requests, median 51 ms
  - /dept/tasks: 335 requests, median 146 ms
  - /meta/versions: 110 requests, median 3 ms
  - /dept/monitoring: 109 requests, median 481 ms
  - /dept/applications/106: 171 requests, median 61 ms
  - /applications?scope=dept&text=20261100009&pageSize=25: 60 requests, median 32 ms
  - /dept/reports/statistics: 57 requests, median 4 ms

Over budget:
- /dept/monitoring?includeDecided=true&page=3 (dfs.officer): 920 ms (budget 500 ms), status 200
- /dept/monitoring?includeDecided=true&page=2 (load.dfo.6): 999 ms (budget 500 ms), status 200
- /admin/statuses (admin): 554 ms (budget 500 ms), status 200
- save the whole application with the server assessment (PUT): 327 ms (budget 300 ms), status 200
