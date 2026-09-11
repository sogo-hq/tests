import { rmSync } from 'node:fs';

/**
 * A database this test file owns outright.
 *
 * The files here used to name theirs `/tmp/x-${process.pid}.db`, which is
 * unique within a run and emphatically not across them: pids recycle, /tmp had
 * 1,832 of these left behind, and a file that landed on a recycled pid opened a
 * previous run's rows. That showed up as one whole test file failing about
 * once in fifteen suite runs, with a test count one short, which reads exactly
 * like flakiness and is not.
 *
 * Deleting the sqlite file alone is not enough: WAL mode leaves -wal and -shm
 * beside it, and a stale WAL carries committed rows the main file has not
 * checkpointed yet.
 */
export function freshDb(name) {
  const path = `/tmp/vitals-${name}-${process.pid}.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  return path;
}
