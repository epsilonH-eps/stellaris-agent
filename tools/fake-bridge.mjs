/**
 * 假原生桥（开发/自测用，**不连游戏**）。
 *
 *   node tools/fake-bridge.mjs [pipeName]
 *
 * 用同名命名管道实现和 stellaris_bridge.dll 一样的 JSON-RPC 2.0，
 * 返回一份最小但结构正确的世界状态，并记录所有写调用。
 * 用来在没有游戏的情况下跑通「读取 → 主会话 → 子会话 → 执行器」全链路。
 *
 * 只用于本地测试：必须在临时 STELLARIS_AGENT_HOME + 独立 pipeName 下使用。
 */
import net from 'node:net'

const pipeName = process.argv[2] || 'stellaris_mcp_e2e'

const state = {
  paused: false,
  speed: 2,
  date: '2200.01.01',
  research: { physics: { current: { key: null, progress: 0 }, options: [{ key: 'tech_lasers_1' }] }, society: { current: { key: null }, options: [] }, engineering: { current: { key: null }, options: [] } },
  activeEvents: [{ window_id: 5, id: 'evt.1', title: '测试事件', options: [{ text: '接受', enabled: true }, { text: '拒绝', enabled: true }] }],
  calls: [],
}

const HANDLERS = {
  get_status: () => ({
    in_game: true,
    is_paused: state.paused,
    speed: state.speed,
    date: { formatted: state.date },
    resources: {
      energy: { stockpile: 500, net: 20, income: 30, expense: 10 },
      minerals: { stockpile: 300, net: 10 },
      alloys: { stockpile: 120, net: 5 },
    },
    empire_size: 12,
    empire_colonies_count: 1,
    owned_systems: 4,
    naval_capacity: 20,
    naval_size: 6,
    outliner: { sectors_summary: { sectors: [{ colonies_summary: [{ planet_id: 3, name: '地球', pops: 12 }] }] } },
  }),
  get_outliner: () => ({ sectors_summary: { sectors: [{ colonies_summary: [{ planet_id: 3, name: '地球', pops: 12 }] }] } }),
  get_sectors: () => ({ sectors: [] }),
  get_government: () => ({ ruler_name: '测试总统', government_type: 'democratic', active_agenda: null, council_seats: [] }),
  get_civics: () => ({ civics: [] }),
  get_edicts: () => ({ active_edicts: [] }),
  get_traditions: () => ({ unlocked_traditions: [], available_trees: [] }),
  get_research_state: () => state.research,
  get_leaders: () => ({ hired: [] }),
  get_species: () => ({ species: [] }),
  get_market: () => ({ resources: [] }),
  get_contacts: () => ({ empires: [] }),
  get_pending_diplomacy: () => ({ proposals: [] }),
  get_wars: () => ({ wars: [] }),
  get_active_events: () => ({ events: state.activeEvents }),
  get_alerts: () => ({ alerts: [] }),
  get_notifications: () => ({ notifications: [] }),
  get_situation_log: () => ({ situations: [] }),
  get_galaxy_overview: () => ({ player: { owned_systems: 4 } }),
  get_galaxy_map: () => ({ rows: [] }),
  get_fleets: (params) => (params && params.fleet_id ? { fleet_id: params.fleet_id, name: '第一舰队', status: 'idle', system_id: 7, stance: 'aggressive' } : { fleets: [{ fleet_id: 1, name: '第一舰队', status: 'idle', system_id: 7 }] }),
  get_military_fleets: () => ({ fleets: [{ fleet_id: 1, name: '第一舰队', status: 'idle', system_id: 7, military_power: 1200 }] }),
  get_civilian_fleets: () => ({ science_ships: [], construction_ships: [], colony_ships: [] }),
  get_armies: () => ({ armies: [] }),
  get_ship_designs: () => ({ designs: [] }),
  get_ship_design_catalog: () => ({}),
  get_discoveries: () => ({}),
  get_planet_details: () => ({ system_id: 7, planet_name: '地球', population: 12, stability: 70, construction_queue: [], designation_key: 'col_capital' }),
  get_planet_jobs: () => ({ jobs: [] }),
  get_planet_armies: () => ({ total_stationed_armies: 2 }),
  get_buildable_buildings: () => ({ buildable: [] }),
  get_buildable_districts: () => ({ buildable: [] }),
  get_available_district_zones: () => ({ zones: [] }),
  get_clearable_blockers: () => ({ blockers: [] }),
  get_planetary_decisions: () => ({ decisions: [] }),
  get_planetary_features: () => ({ features: [] }),
  get_terraforming_options: () => ({ options: [] }),
  get_system: () => ({ system_id: 7, name: '太阳系', megastructures: [] }),
  get_diplomacy_options: () => ({ options: [] }),
  get_war_goal_candidates: () => ({ candidates: [] }),
  get_buildable_ships: () => ({ queue: [] }),
  get_buildable_megastructures: () => ({ megastructures: [] }),

  set_paused: (params) => {
    state.paused = Boolean(params.paused)
    return { ok: true }
  },
  set_speed: (params) => {
    state.speed = Number(params.speed)
    return { ok: true }
  },
  select_research: (params) => {
    state.research[params.slot] = { ...(state.research[params.slot] || {}), current: { key: params.tech_key, progress: 0 } }
    return { ok: true }
  },
  resolve_event: (params) => {
    state.activeEvents = state.activeEvents.filter((event) => event.window_id !== Number(params.window_id))
    return { ok: true }
  },
}

const server = net.createServer((socket) => {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const handler = HANDLERS[message.method]
      state.calls.push({ method: message.method, params: message.params || {} })
      console.log(`[rpc] ${message.method} ${JSON.stringify(message.params || {})}`)
      if (!handler) {
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } }) + '\n')
        continue
      }
      try {
        const result = handler(message.params || {})
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
      } catch (error) {
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error?.message || error) } }) + '\n')
      }
    }
  })
})

server.listen(`\\\\.\\pipe\\${pipeName}`, () => {
  console.log(`[fake-bridge] listening \\\\.\\pipe\\${pipeName}`)
})
