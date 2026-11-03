# Private capacity-driver lifecycle verification

This follow-up to merged PR #284 changes the private operator tool and one reader-test title. It isolates Wrangler child process groups, verifies local shutdown, and bounds tail provisioning across credential renewal. Verified forced termination counts as successful cleanup with an escalation warning. The tool supports macOS/Linux and rejects other platforms before credential, child or network activity.

## Local regression coverage

The focused process, runner, reader and deployment-adapter suites passed 243 tests. Real terminal group SIGINT is exercised five times against a held deployment child: the driver retains exit code 130, the isolated child completes, and helper deletion follows confirmed deployment completion. A separate five-repetition real-process schedule verifies that a grandchild is stopped even after its direct parent exits. Both schedules use bounded wall-clock backstops. Cleanup stops local provisioning before deleting remote resources, then verifies any credential children created during remote cleanup.

Deterministic tests cover refused signals, graceful and forced termination, delayed exit evidence, failed/hanging group probes, zombie membership, occupied ports, unsupported platforms and preserved signal status. Credential output remains in memory, is size bounded and is absent from journals. A hung credential child is terminated and its group verified stopped.

Tail tests cover an ID returned after interruption, an unknown outcome at expiry, malformed responses with a recoverable tail ID, and fresh cleanup credentials after an aborted OAuth renewal. A fake-clock regression asserts cleanup starts exactly at the tail deadline. The request and renewal use the same absolute operation budget; cleanup receives an independent budget. All remote API and RPC responses in these tests are synthetic.

The reader test now accurately names the conflict in the rebuilt row-page read; its existing bounded-restart assertions remain unchanged.

## Gate and mutation results

`VITEST_MAX_WORKERS=2 pnpm check` passed, including all 2,538 Worker tests and coverage thresholds, formatting, documentation, lint, middleware/deployment rules, all type checks, dead-code analysis, binding verification, application build and a local Worker dry run. Its unit coverage phase passed 3,100 tests with one existing skip. After adding the cleanup-order regression, final unit coverage passed 3,101 tests with the same skip, and lint passed again. The dry run did not deploy production.

Three temporary source mutations each failed at the intended assertion, and the original file was restored after every run:

| Mutation                              | Observed regression                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| Remove child process-group isolation  | The terminal SIGINT case no longer confirms settled deployment and completed cleanup. |
| Ignore failed local stop verification | The refusing-proxy case incorrectly reports successful cleanup.                       |
| Extend the tail deadline tenfold      | The fake-clock test finds no cleanup request at the required deadline.                |

The tests and mutation checks use only fake remote resources or bounded disposable local process groups. The driver implementation and compatible fixture are in commit `355f823`, based on merged main `9287a54`.

## Operational boundaries and Sonar

No preview or production operations, D1 writes, live smoke runs, capacity/sign-in studies or deployments were performed for this follow-up. Historical preview evidence remains unchanged. C6 remains skipped/incomplete. The application's password parameters, 16-shard pool, runtime behavior and Windows deployment support are unchanged. There is no automatic merge.

[Sonar alert 41](https://github.com/hbmartin/noteflare/security/code-scanning/41), `javascript:S5332`, points to fake URL data consumed by an injected `EventEmitter` socket factory. It does not represent a clear-text network connection. The fixture URL, alert disposition, suppressions and scanner configuration were not changed. Sonar quality-gate status is reported separately from local validation.
