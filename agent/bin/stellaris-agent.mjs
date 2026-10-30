#!/usr/bin/env node
import { run } from '../lib/cli.mjs'

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = Number(code) || 0
  })
  .catch((error) => {
    console.error(String(error?.message || error))
    process.exitCode = 1
  })
