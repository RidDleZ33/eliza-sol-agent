#!/bin/bash
# Swarm Management Script
# Usage: ./swarm.sh {start|stop|restart|status|build}

PID_FILE="/home/user/eliza-sol-agent/swarm.pid"
LOG_FILE="/home/user/eliza-sol-agent/swarm.log"
SWARM_DIR="/home/user/eliza-sol-agent"
BUN="/home/user/.bun/bin/bun"

get_pid() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "$pid"
            return 0
        fi
    fi
    return 1
}

start_swarm() {
    if [ -n "$(get_pid)" ]; then
        echo "Swarm already running (PID: $(get_pid))"
        return 0
    fi

    echo "Starting swarm..."
    cd "$SWARM_DIR"
    $BUN run src/index.ts >> "$LOG_FILE" 2>&1 < /dev/null &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    echo "Swarm started (PID: $pid)"
    
    # Wait a few seconds to confirm it's still running
    sleep 5
    if kill -0 "$pid" 2>/dev/null; then
        echo "Swarm is running"
    else
        echo "Swarm failed to start - check $LOG_FILE"
        rm -f "$PID_FILE"
    fi
}

stop_swarm() {
    local pid=$(get_pid)
    if [ -z "$pid" ]; then
        echo "Swarm is not running"
        return 0
    fi

    echo "Stopping swarm (PID: $pid)..."
    kill "$pid"
    
    # Wait for process to exit
    for i in {1..30}; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "Swarm stopped"
            rm -f "$PID_FILE"
            return 0
        fi
        sleep 1
    done
    
    echo "Force killing swarm..."
    kill -9 "$pid" 2>/dev/null
    rm -f "$PID_FILE"
    echo "Swarm stopped"
}

restart_swarm() {
    stop_swarm
    sleep 2
    start_swarm
}

status_swarm() {
    local pid=$(get_pid)
    if [ -n "$pid" ]; then
        echo "Swarm is running (PID: $pid)"
    else
        echo "Swarm is not running"
    fi
}

build_swarm() {
    echo "Building swarm..."
    cd "$SWARM_DIR"
    $BUN run build
}

case "$1" in
    start)
        start_swarm
        ;;
    stop)
        stop_swarm
        ;;
    restart)
        restart_swarm
        ;;
    status)
        status_swarm
        ;;
    build)
        build_swarm
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|build}"
        exit 1
        ;;
esac