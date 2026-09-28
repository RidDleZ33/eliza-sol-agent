#!/bin/bash
cd /home/user/eliza-sol-agent
rm -rf data/tape
node_modules/.bin/bun src/tape/index.ts &
PID=$!
sleep 35
kill $PID 2>/dev/null
wait $PID 2>/dev/null
echo "tape recorder finished"
node -e "const db = require('better-sqlite3')('data/tape/tape.sqlite'); console.log('market_ticks:', db.prepare('SELECT COUNT(*) as cnt FROM market_ticks').get().cnt); console.log('discovery_events:', db.prepare('SELECT COUNT(*) as cnt FROM discovery_events').get().cnt); console.log('sol_marks:', db.prepare('SELECT COUNT(*) as cnt FROM sol_marks').get().cnt); console.log('errors:', db.prepare('SELECT COUNT(*) as cnt FROM recorder_errors').get().cnt); db.close();"
node -e "const db = require('better-sqlite3')('data/tape/tape.sqlite'); const tick = db.prepare('SELECT symbol, name, price_usd, vol_5m_usd, tx_5m_buys, pair_created_at_ms FROM market_ticks LIMIT 1').get(); console.log(JSON.stringify(tick, null, 2)); db.close();"
