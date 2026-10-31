import test from 'node:test'
import assert from 'node:assert/strict'

import { selectFollowTarget } from '../agent/lib/ui.mjs'

test('镜头跟随：优先有任务的舰队，没有则人口最多的星球', () => {
  const world = {
    fleetsAll: [
      { fleet_id: 1, kind: 'science', status: '无指令' },
      { fleet_id: 2, kind: 'construction', status: '正在前往克鲁斯星系' },
      { fleet_id: 3, kind: 'military', status: '战斗中' },
    ],
    colonies: [
      { planet_id: 10, name: 'A', population: 30 },
      { planet_id: 11, name: 'B', population: 50 },
    ],
  }
  const target = selectFollowTarget(world)
  assert.equal(target.type, 'fleet')
  assert.equal(target.id, 3)

  const peaceful = selectFollowTarget({ ...world, fleetsAll: [{ fleet_id: 1, status: '无指令' }] })
  assert.equal(peaceful.type, 'planet')
  assert.equal(peaceful.id, 11)
})
