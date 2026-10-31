# Free-plan CPU measurements

Measured on 30 October 2026 using an Apple M2 Pro, Node 26.11.1, and local workerd 1.20261006.1. The working tree was based on `affbd477a66c59309a64888bf73ee7fa4a619d86`. No application runtime code was changed for this measurement.

The current password authentication and larger conversion jobs have substantial CPU work beyond a 10 ms budget. These measurements do not establish reliable Workers Free operation. Small Markdown/HTML exports have more room; ordinary authenticated requests need deployed CPU measurements before drawing a firm conclusion.

## Reproduce

On macOS with Xcode command-line tools/clang and the project dependencies installed:

```sh
node scripts/measure-free-plan-cpu.mjs
```

The benchmark creates ephemeral Miniflare resources, applies all 104 D1 migrations, bootstraps and protects a synthetic account, seeds 1,000 pages, and runs the actual HTTP handlers and production Workflow implementation. Each repeated case has three warmups and 20 measured samples; first-run enrollment operations have one sample. This run collected 1,784 measurements. Every measured job completed, export artifacts were checked for nonempty output, and the search fixture returned actual indexed matches.

The Markdown fixtures contain approximately 2, 20, or 200 KiB of repeated paragraphs with bold, emphasis, and links. More precisely, their bodies contain 2,048, 20,480, and 204,800 ASCII bytes plus a 17-byte heading. CPU measurements surround each job step separately. Synthetic conversion measurements prepare their input document before starting the CPU counter.

The script writes complete measurements and a table into a new `.wrangler/cpu-bench/` directory. `NOTES_CPU_SAMPLES` and `NOTES_CPU_WARMUPS` control repetition. The [saved summary](free-plan-cpu-2026-10-30.json) contains every case and its environment metadata.

## Measurement method and limits

The primary measurement is the change in the local workerd process's OS user plus system CPU, read with `proc_pid_rusage`. Mach ticks are converted with `mach_timebase_info`. Profiling is disabled during the final measurement. Calibration returned:

| Control                     | Median CPU |  P95 CPU |
| --------------------------- | ---------: | -------: |
| Empty response              |    0.29 ms |  0.42 ms |
| 100 ms idle timer wait      |    0.72 ms |  1.19 ms |
| 30 ms synchronous busy loop |   30.14 ms | 30.47 ms |

For HTTP handlers and job steps, this is a **local CPU upper bound**, including emulated D1/R2/Durable Object backends, runtime threads, and background work. A total above 10 ms does not prove that the deployed HTTP handler or Workflow step itself exceeds 10 ms. Isolated transformations reduce this ambiguity by measuring the expensive production operation without storage calls. Values also depend on hardware, document shape, garbage collection, and runtime version.

Job execution replaces Workflow step persistence, retries, and scheduling with an instrumented `step.do` shim. Engine overhead and replay behavior are not measured. Local Free CPU enforcement is not tested. AI, Slack delivery, PDF/browser rendering, table-heavy data, realtime message throughput, and concurrency are not included. Rate-limit bindings use high thresholds and password attempt counters are cleared between sign-in samples so throttling cannot replace the measured work with a rejection. External network access is blocked, and existing local/remote databases and `.dev.vars` are not used.

An initial diagnostic run used V8 CPU profiles. The idle calibration exposed unsampled I/O gaps being charged to active frames, so those durations were discarded for budget comparisons. `NOTES_CPU_PROFILE=1` remains available for diagnostic profiles, with sampler overhead included in process totals.

Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) specify 10 ms per Free HTTP request. Its [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/) describe the 10 ms allowance per step. Local timing is not Cloudflare billing or admission evidence.

## Isolated production computations

These operations run without D1/R2 calls inside the measured interval. All rows have 20 samples. The Word writer includes its asynchronous ZIP generation; the OS CPU counter excludes its idle waits.

| Operation                                                           | Median CPU |   P95 CPU | Samples above 10 ms |
| ------------------------------------------------------------------- | ---------: | --------: | ------------------: |
| Password hash using the configured production scrypt implementation |   50.05 ms |  52.00 ms |               20/20 |
| Parse Markdown, ~20 KiB                                             |    1.93 ms |   2.85 ms |                0/20 |
| Encode Yjs, ~20 KiB                                                 |    3.09 ms |   8.16 ms |                0/20 |
| Serialize Markdown and HTML, ~20 KiB                                |    3.33 ms |   4.89 ms |                0/20 |
| Parse Markdown, ~200 KiB                                            |   16.56 ms |  20.23 ms |               20/20 |
| Encode Yjs, ~200 KiB                                                |   41.66 ms |  53.51 ms |               20/20 |
| Serialize Markdown and HTML, ~200 KiB                               |   32.78 ms |  37.85 ms |               20/20 |
| Generate Word document, ~2 KiB                                      |   12.03 ms |  16.11 ms |               18/20 |
| Generate Word document, ~20 KiB                                     |   31.45 ms |  38.47 ms |               20/20 |
| Generate Word document, ~200 KiB                                    |  335.09 ms | 411.38 ms |               20/20 |

## HTTP and job-step totals

These totals include local backends. The last column counts local upper bounds above the threshold, not Cloudflare limit failures. All rows have 20 samples.

| Operation                                    | Median local CPU upper bound |       P95 | Above 10 ms |
| -------------------------------------------- | ---------------------------: | --------: | ----------: |
| Health endpoint                              |                      0.77 ms |   0.92 ms |        0/20 |
| Password sign-in, returning a TOTP challenge |                     74.69 ms |  78.00 ms |       20/20 |
| Authenticated session lookup                 |                      9.68 ms |  15.58 ms |        8/20 |
| Page metadata read                           |                     10.01 ms |  16.74 ms |       11/20 |
| Create a page                                |                     12.28 ms |  18.72 ms |       20/20 |
| Page tree, 1,000 pages                       |                     15.34 ms |  21.90 ms |       20/20 |
| Search, 1,000 indexed pages                  |                     11.74 ms |  13.40 ms |       20/20 |
| Maintenance cron, 1,000 pages                |                     25.67 ms |  37.84 ms |       20/20 |
| Reindex first batch, 100 pages               |                     23.93 ms |  24.66 ms |       20/20 |
| Import inspection step, ~2 KiB               |                      1.66 ms |   3.91 ms |        0/20 |
| Import write-content step, ~2 KiB            |                     21.52 ms |  27.37 ms |       20/20 |
| Markdown export render step, ~2 KiB          |                      3.18 ms |   5.99 ms |        0/20 |
| HTML export render step, ~2 KiB              |                      3.08 ms |   4.77 ms |        0/20 |
| Markdown export render step, ~20 KiB         |                      8.92 ms |  12.49 ms |        4/20 |
| Word export render step, ~2 KiB              |                     13.87 ms |  19.74 ms |       20/20 |
| Word export render step, ~20 KiB             |                     40.96 ms |  54.07 ms |       20/20 |
| Import inspection step, ~200 KiB             |                     21.40 ms |  40.70 ms |       20/20 |
| Word export render step, ~200 KiB            |                    375.14 ms | 474.40 ms |       20/20 |

## Implications

Keep Workers Paid as the supported target for the complete feature set. Password hashing alone uses roughly five times the Free CPU allowance on this machine; reducing traffic does not reduce the CPU required by an individual login. Do not weaken password hashing to meet this limit.

A Free-focused variant would need to avoid expensive password operations on normal login paths and bound conversion work within each step. Merely moving a large conversion into a Workflow does not resolve its per-step CPU budget. Word generation and large document conversions need specific redesign or a runtime with a larger budget. For ordinary reads, cron work, and reindexing, obtain deployed per-invocation CPU evidence before deciding which local overhead requires application changes.

Validation: the full benchmark completed, calibration passed, and the benchmark script passed Oxfmt and Oxlint. No deployment or production configuration changes were made.
