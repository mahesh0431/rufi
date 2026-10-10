// The notice timer on its own: one claim at a time, and a failed or
// unanswered claim never stops the next one. The claim is the channel to
// Rufi (core.ts), faked here; the app's tests run the real one.
import type { PersonNotices } from "@rufi/contracts/app";
import { expect, it } from "vitest";
import { noticeTimer } from "./notices.ts";

it("claims once at a time, and claims again after a failed claim", async () => {
  const answers: (() => Promise<readonly PersonNotices[]>)[] = [
    () => Promise.reject(new Error("Rufi didn't answer in time.")),
    () =>
      Promise.resolve([
        { personId: "asha", due: 1, overdue: 2 },
        { personId: "ravi", due: 0, overdue: 0 },
      ]),
  ];
  let claims = 0;
  let release: () => void = () => undefined;
  const told: PersonNotices[] = [];
  const timer = noticeTimer({
    claim: () => {
      claims += 1;
      const answer = answers[claims - 1];
      return new Promise((resolve, reject) => {
        release = () => {
          answer?.().then(resolve, reject);
        };
      });
    },
    tell: (person) => told.push(person),
    failed: () => undefined,
  });

  timer.check();
  timer.check();
  expect(claims).toBe(1);
  release();
  await expect.poll(() => (timer.check(), claims)).toBe(2);
  release();

  await expect
    .poll(() => told)
    .toEqual([{ personId: "asha", due: 1, overdue: 2 }]);
  timer.stop();
});
