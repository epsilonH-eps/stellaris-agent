/**
 * 直播弹幕队列：独立版直接用桥里的 LiveChat（同一份实现，不重复造）。
 *
 * @module stellaris-agent/bus
 */
import { LiveChat } from '../../engine/lib/livechat.js'

export function createBus(config = {}) {
  return new LiveChat({
    maxQueue: Number(config.maxQueue ?? 200),
    allowSay: config.allowSay !== false,
  })
}
