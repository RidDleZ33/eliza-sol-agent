#!/bin/bash
# Tape Recorder Management Script
# Usage: ./tape.sh {start|stop|restart|status|logs}

PID_FILE="/home/user/eliza-sol-agent/tape.pid"
LOG_FILE="/home/user/eliza-sol-agent/tape.log"
TAPE_DIR="/home/user/eliza-sol-agent"
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

start_tape() {
    if [ -n "$(get_pid)" ]; then
        echo "Tape recorder already running (PID: $(get_pid))"
        return 0
    fi

    echo "Starting tape recorder..."
    cd "$TAPE_DIR"
    $BUN run tape >> "$LOG_FILE" 2>&1 < /dev/null &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    echo "Tape recorder started (PID: $pid)"

    # Wait a few seconds to confirm it's still running
    sleep 5
    if kill -0 "$pid" 2>/dev/null; then
        echo "Tape recorder is running"
    else
        echo "Tape recorder failed to start - check $LOG_FILE"
        rm -f "$PID_FILE"
    fi
}

stop_tape() {
    local pid=$(get_pid)
    if [ -z "$pid" ]; then
        echo "Tape recorder is not running"
        return 0
    fi

    echo "Stopping tape recorder (PID: $pid)..."
    kill "$pid"

    # Wait for process to exit
    for i in {1..30}; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "Tape recorder stopped"
            rm -f "$PID_FILE"
            return 0
        fi
        sleep 1
    done

    echo "Force killing tape recorder..."
    kill -9 "$pid" 2>/dev/null
    rm -f "$PID_FILE"
    echo "Tape recorder stopped"
}

restart_tape() {
    stop_tape
    sleep 2
    start_tape
}

status_tape() {
    local pid=$(get_pid)
    if [ -n "$pid" ]; then
        echo "Tape recorder is running (PID: $pid)"
    else
        echo "Tape recorder is not running"
    fi
}

logs_tape() {
    if [ ! -f "$LOG_FILE" ]; then
        echo "Log file not found: $LOG_FILE"
        return 1
    fi
    tail -f "$LOG_FILE"
}

case "$1" in
    start)
        start_tape
        ;;
    stop)
        stop_tape
        ;;
    restart)
        restart_tape
        ;;
    status)
        status_tape
        ;;
    logs)
        logs_tape
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
