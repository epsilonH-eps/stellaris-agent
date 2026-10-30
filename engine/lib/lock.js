/**
 * 一个极小的串行锁。
 *
 * 用途：群星的**控制台只有一个**。两条 lane 同时注入，后一条的按键会打进
 * 前一条还没关的控制台里，命令就串了。所以「写文件 → 开控制台 → 输入 →
 * 等 ACK」这一段必须全局互斥，lane 只保证「同一通道内保序」。
 *
 * 实现就是一条 promise 链：后来的任务排在前一个的 then 后面。
 *
 * @module dsh-stellaris-bridge/lock
 */
export function createLock() {
  let tail = Promise.resolve()
  return function runExclusive(task) {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
