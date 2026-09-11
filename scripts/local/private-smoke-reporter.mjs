// Magic links and profile proofs can appear in browser error messages. Never
// forward raw messages, stacks, stdout, attachments or network details to logs.
export default class PrivateSmokeReporter {
  emit(event, test, status, frames = []) {
    console.log(JSON.stringify({ event, status, file: test?.location.file.split("/").pop() ?? "runner", line: test?.location.line ?? 0, frames }));
  }
  onTestBegin(test) { this.emit("start", test, "running"); }
  onTestEnd(test, result) {
    this.emit("end", test, result.status);
    if (result.status !== "passed" && result.status !== "skipped") {
      for (const error of result.errors) {
        const frames = String(error.stack ?? "").match(/(?:tests\/e2e\/[A-Za-z0-9_.-]+\.spec\.ts):\d+:\d+/g) ?? [];
        this.emit("failure", test, result.status, [...new Set(frames)]);
      }
    }
  }
  onError() { this.emit("error", null, "failed"); }
  onEnd(result) { this.emit("run", null, result.status); }
}
